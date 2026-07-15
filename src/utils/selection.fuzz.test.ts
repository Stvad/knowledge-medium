// @vitest-environment node
/**
 * Fuzz suite for the pure multi-select selection helpers in
 * `src/utils/selection.ts`. See `src/test/fuzz.ts` for smoke/deep tier
 * mechanics and `docs/fuzzing.md` for conventions.
 *
 * ──── Contract, grounded at the call sites ────
 *
 * `blockIdsInOrderedSelectionRange` (selection.ts:250-267) and
 * `findBestSelectionAnchorIndex` (selection.ts:269-312) both take an
 * `orderedLocations: readonly FocusedBlockLocation[]` plus integer indices
 * *into that same array*. The one real caller,
 * `extendSelectionToSpatialTarget` (src/plugins/spatial-navigation/actions.ts:77-114),
 * builds `orderedLocations` from `locationsOf(panelInstances(panel))` — the
 * live DOM instances of a panel in document order (walker.ts:118-130) mapped
 * through `locationOf` (walker.ts:107-110), which reads
 * `{blockId, renderScopeId}` straight off `dataset` — so the SAME `blockId`
 * legitimately repeats (a block rendered in the outline AND in one or more
 * backlink/embed entries), each occurrence carrying a distinct
 * `renderScopeId` (one per DOM element). `anchorIndex`/`targetIndex` come
 * from `findBestSelectionAnchorIndex(...)` and `instances.indexOf(target)`
 * against that exact array (actions.ts:97-110), so in real usage they are
 * always valid indices into `orderedLocations` — but both functions also
 * defensively guard out-of-range indices with an explicit, documented
 * sentinel return (`[]` at selection.ts:255-260, `-1` at selection.ts:284),
 * so exercising those paths tests real code contract, not an out-of-scope
 * input.
 *
 * `validateSelectionHierarchy` (selection.ts:218-245) takes an arbitrary
 * `selectedIds: string[]` plus a `Repo`; it hydrates each id's ancestor
 * chain (`repo.load(id, {ancestors: true})`) and then walks
 * `repo.cache.getSnapshot(id)?.parentId` via the private `isDescendantOf`
 * (selection.ts:200-211). The only `Repo`/`Block` surface it touches is
 * `repo.load`, `repo.block(id)`, `block.peek()` (→ `repo.cache.getSnapshot`
 * / `repo.cache.isMissing`, block.ts:94-99) — so the fake repo below
 * implements exactly that surface (same "minimal fake for the exact surface
 * read" pattern as the fake `Tx` in `orderKeyPlacement.fuzz.test.ts`), using
 * the real `Block` class rather than reimplementing its `peek()` logic. The
 * generated tree is fully materialized into the fake cache up front, so
 * `repo.load(id, {ancestors: true})` is a legitimate no-op: the precondition
 * it exists to satisfy (ancestor chain hydrated into cache) already holds.
 *
 * ──── Candidate properties dropped ────
 *
 * - "toggle-twice is an involution" (candidate 6): the toggle logic
 *   (`isSelected ? filter(...) : [...ids, block.id]`) lives inline in
 *   `blockSelectionAction.ts`'s handler (lines 70-73), not in any pure
 *   helper exported from selection.ts — there is nothing here to call twice
 *   and compare. `validateSelectionHierarchy`'s idempotence (property 4
 *   below) is the closest genuine law that lives in the pure surface.
 */
import { describe, expect, it } from 'vitest'
import fc from 'fast-check'
import { fuzzParams } from '@/test/fuzz'
import type { BlockData } from '@/data/api'
import { Block } from '@/data/block'
import type { Repo } from '@/data/repo'
import type { FocusedBlockLocation } from '@/data/properties'
import {
  blockIdsInOrderedSelectionRange,
  findBestSelectionAnchorIndex,
  validateSelectionHierarchy,
} from './selection'

// ──── orderedLocations generators (properties 1, 2, 5) ────

const BLOCK_ID_POOL = ['A', 'B', 'C', 'D', 'E', 'F'] as const

/** A visible-order list with repeated blockIds (same block, multiple render
 *  surfaces) but a unique renderScopeId per position — matching the DOM
 *  contract described above. */
const orderedLocationsArb: fc.Arbitrary<FocusedBlockLocation[]> = fc
  .array(fc.constantFrom(...BLOCK_ID_POOL), {minLength: 1, maxLength: 25})
  .map(blockIds => blockIds.map((blockId, index) => ({blockId, renderScopeId: `scope-${index}`})))

/** Index candidates that skew toward valid range but also probe the
 *  documented out-of-range sentinel paths. */
const indexArb = (length: number): fc.Arbitrary<number> =>
  fc.integer({min: -2, max: length + 1})

const rangeCaseArb = orderedLocationsArb.chain(locations =>
  fc.record({
    locations: fc.constant(locations),
    anchorIndex: indexArb(locations.length),
    targetIndex: indexArb(locations.length),
  }),
)

const anchorCaseArb = orderedLocationsArb.chain(locations => {
  const presentBlockIds = Array.from(new Set(locations.map(l => l.blockId)))
  return fc.record({
    locations: fc.constant(locations),
    anchorBlockId: fc.oneof(
      fc.constantFrom(...presentBlockIds),
      fc.constant('missing-anchor'),
    ),
    targetIndex: indexArb(locations.length),
    selectedBlockIds: fc.subarray(locations.map(l => l.blockId)),
    currentLocation: fc.oneof(
      fc.constant(undefined),
      fc.constantFrom(...locations),
      fc.record({
        blockId: fc.constantFrom(...BLOCK_ID_POOL, 'missing-anchor'),
        renderScopeId: fc.string(),
      }),
    ),
  })
})

describe('blockIdsInOrderedSelectionRange', () => {
  it('returns a contiguous, endpoint-order-independent slice of the visible order (selection.ts:255-266)', () => {
    fc.assert(
      fc.property(rangeCaseArb, ({locations, anchorIndex, targetIndex}) => {
        const result = blockIdsInOrderedSelectionRange(locations, anchorIndex, targetIndex)
        const swapped = blockIdsInOrderedSelectionRange(locations, targetIndex, anchorIndex)
        // Endpoints are interchangeable — the code computes start/end via
        // min/max before slicing (selection.ts:262-263).
        expect(swapped).toEqual(result)

        const inRange = anchorIndex >= 0 && targetIndex >= 0 &&
          anchorIndex < locations.length && targetIndex < locations.length
        if (!inRange) {
          expect(result).toEqual([])
          return
        }
        const start = Math.min(anchorIndex, targetIndex)
        const end = Math.max(anchorIndex, targetIndex)
        const expectedIds = Array.from(
          new Set(locations.slice(start, end + 1).map(l => l.blockId)),
        )
        expect(result).toEqual(expectedIds)
      }),
      fuzzParams(300),
    )
  })

  it('every returned id is present in the visible order, with no duplicates (selection.ts:247-248, 264-266)', () => {
    fc.assert(
      fc.property(rangeCaseArb, ({locations, anchorIndex, targetIndex}) => {
        const result = blockIdsInOrderedSelectionRange(locations, anchorIndex, targetIndex)
        expect(new Set(result).size).toBe(result.length)
        const visibleIds = new Set(locations.map(l => l.blockId))
        for (const id of result) expect(visibleIds.has(id)).toBe(true)
      }),
      fuzzParams(300),
    )
  })
})

describe('findBestSelectionAnchorIndex', () => {
  it('returns -1, or an in-range index whose location matches anchorBlockId (selection.ts:284-311)', () => {
    fc.assert(
      fc.property(anchorCaseArb, ({locations, anchorBlockId, targetIndex, selectedBlockIds, currentLocation}) => {
        const result = findBestSelectionAnchorIndex(locations, {
          anchorBlockId,
          targetIndex,
          selectedBlockIds,
          currentLocation,
        })

        const targetInRange = targetIndex >= 0 && targetIndex < locations.length
        const anchorPresent = locations.some(l => l.blockId === anchorBlockId)

        if (!targetInRange || !anchorPresent) {
          // Documented sentinels: line 284 (target OOB) and line 289
          // (`candidates.length === 0`, i.e. anchor absent).
          expect(result).toBe(-1)
          return
        }
        expect(result).toBeGreaterThanOrEqual(0)
        expect(result).toBeLessThan(locations.length)
        expect(locations[result].blockId).toBe(anchorBlockId)
      }),
      fuzzParams(300),
    )
  })
})

// ──── validateSelectionHierarchy generators + fake repo (properties 3, 4) ────

interface FakeNode {
  id: string
  parentId: string | null
}

/** Random forest of <=30 nodes: each node's parent (if any) is drawn only
 *  from EARLIER-generated ids, so the parent pointers are acyclic by
 *  construction — matching `isDescendantOf`'s own cycle guard
 *  (selection.ts:204-205), which exists for defense-in-depth against
 *  corrupted data, not because well-formed input can cycle. */
const forestArb: fc.Arbitrary<FakeNode[]> = fc.integer({min: 1, max: 30}).chain(size => {
  const ids = Array.from({length: size}, (_, i) => `n${i}`)
  return fc
    .tuple(...ids.map((_, i) => (i === 0 ? fc.constant(-1) : fc.integer({min: -1, max: i - 1}))))
    .map(parentIndexes => ids.map((id, i) => ({
      id,
      parentId: parentIndexes[i] === -1 ? null : ids[parentIndexes[i]],
    })))
})

const selectedIdsArb = (nodes: FakeNode[]): fc.Arbitrary<string[]> =>
  fc.array(fc.constantFrom(...nodes.map(n => n.id)), {minLength: 0, maxLength: nodes.length + 3})

const hierarchyCaseArb = forestArb.chain(nodes =>
  fc.record({
    nodes: fc.constant(nodes),
    selectedIds: selectedIdsArb(nodes),
  }),
)

const mkBlockData = (id: string, parentId: string | null): BlockData => ({
  id,
  workspaceId: 'ws',
  parentId,
  orderKey: 'a',
  content: '',
  properties: {},
  references: [],
  createdAt: 0,
  updatedAt: 0,
  userUpdatedAt: 0,
  createdBy: 'u',
  updatedBy: 'u',
  deleted: false,
})

/** Minimal fake satisfying only the `Repo` surface `validateSelectionHierarchy`
 *  and its private `isDescendantOf` helper actually read: `repo.load`,
 *  `repo.block(id)` (→ a real `Block` instance), and — through `Block.peek()`
 *  — `repo.cache.getSnapshot` / `repo.cache.isMissing`. The whole generated
 *  tree is pre-loaded into the cache, so `repo.load(..., {ancestors: true})`
 *  is a legitimate no-op (see docblock above). */
const makeFakeRepo = (nodes: FakeNode[]): Repo => {
  const byId = new Map(nodes.map(n => [n.id, mkBlockData(n.id, n.parentId)]))
  const cache = {
    getSnapshot: (id: string): BlockData | undefined => byId.get(id),
    isMissing: (id: string): boolean => !byId.has(id),
  }
  const fakeRepo = {
    cache,
    block: (id: string): Block => new Block(fakeRepo as unknown as Repo, id),
    load: async (): Promise<null> => null,
  }
  return fakeRepo as unknown as Repo
}

/** Independent ancestor-chain model (not `isDescendantOf`, which is the code
 *  under test) — closest-first ancestor ids of `id` per the fake tree's
 *  parentId pointers. */
const ancestorsOf = (byId: Map<string, FakeNode>, id: string): Set<string> => {
  const result = new Set<string>()
  const seen = new Set<string>([id])
  let currentId = byId.get(id)?.parentId ?? null
  while (currentId !== null && !seen.has(currentId)) {
    result.add(currentId)
    seen.add(currentId)
    currentId = byId.get(currentId)?.parentId ?? null
  }
  return result
}

describe('validateSelectionHierarchy', () => {
  it('never keeps both a block and one of its ancestors (selection.ts:218-245, ancestor rule verified against an independent walk)', async () => {
    await fc.assert(
      fc.asyncProperty(hierarchyCaseArb, async ({nodes, selectedIds}) => {
        const repo = makeFakeRepo(nodes)
        const byId = new Map(nodes.map(n => [n.id, n]))
        const result = await validateSelectionHierarchy(selectedIds, repo)

        for (const x of result) {
          const xAncestors = ancestorsOf(byId, x)
          for (const y of result) {
            if (x === y) continue
            expect(xAncestors.has(y)).toBe(false)
          }
        }
      }),
      fuzzParams(150),
    )
  })

  it('is idempotent: re-validating its own output changes nothing (selection.ts:225-244 — a set with no ancestor/descendant pairs left never triggers a removal, so a second pass adds every id back in the same order)', async () => {
    await fc.assert(
      fc.asyncProperty(hierarchyCaseArb, async ({nodes, selectedIds}) => {
        const repo = makeFakeRepo(nodes)
        const once = await validateSelectionHierarchy(selectedIds, repo)
        const twice = await validateSelectionHierarchy(once, repo)
        expect(twice).toEqual(once)
      }),
      fuzzParams(150),
    )
  })
})
