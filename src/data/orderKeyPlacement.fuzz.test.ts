// @vitest-environment node
/**
 * Fuzz suite for `src/data/orderKeyPlacement.ts` — tie-breaking order-key
 * placement (spec §4.1 / A1). See `src/test/fuzz.ts` for smoke/deep tier
 * mechanics and `docs/fuzzing.md` for conventions.
 *
 * Contract under test, cited from the code:
 *  - `siblings` is the parent's children in ascending `(order_key, id)`
 *    order — `tx.childrenOf` is documented as "ordered `(order_key, id)`"
 *    (src/data/api/tx.ts:185) and every real caller reads it straight from
 *    there (e.g. `mutators.ts:86-87` "Reads sibling list from SQL (tx.childrenOf
 *    is sorted by (order_key, id) per §11.4)"). Ties — multiple siblings
 *    sharing one `order_key` — are an explicitly supported on-disk state
 *    per orderKeyPlacement.ts's own docblock (lines 6-11): "two adjacent
 *    siblings sharing an `order_key` is a supported on-disk state ... no key
 *    sorts strictly between two tied siblings ... the only way to open a
 *    strict slot ... is to RE-KEY the minimal tied run."
 *  - `anchor` is always a valid index into a NON-EMPTY `siblings` array —
 *    every call site computes it via `siblings.findIndex(...)` and either
 *    throws (`mutators.ts:116-120`) or bails out with an early return
 *    (`moveVertical`, `mutators.ts:657-658`: `if (idx === -1) return false`)
 *    before ever calling `keyImmediatelyBefore/After`. An empty `siblings`
 *    array has no valid anchor index at all, so it is out of contract and
 *    intentionally excluded here (not a "does it handle empty" oracle).
 *  - The only `Tx` method either helper calls is
 *    `tx.move(id, {parentId, orderKey})` (orderKeyPlacement.ts:55, :86) —
 *    no other `Tx` surface is touched, so the fake tx below only needs to
 *    implement `move`.
 *  - "Immediately before/after" (orderKeyPlacement.ts:28-31, :60-63): the
 *    returned keys must sort strictly between the anchor and its neighbour
 *    on the requested side, breaking any tie that blocks the slot by
 *    re-keying the minimal affected run — that scoped re-key is the whole
 *    reason the file exists, and duplicate/tied keys surviving it is
 *    exactly the #198/#182/#188 bug class the docblock calls out.
 *
 * The underlying key generator (`fractional-indexing-jittered`, wrapped by
 * `orderKey.ts`) draws on `Math.random` for jitter — the only nondeterminism
 * in this stack — so it's pinned per case via `statefulFuzzGuard`
 * (`@/test/fuzz`), making fast-check's shrink/seed-replay sound.
 */
import { afterAll, describe, expect, it } from 'vitest'
import fc from 'fast-check'
import { fuzzParams, statefulFuzzGuard } from '@/test/fuzz'
import type { BlockData, Tx } from '@/data/api'
import { makeBlockData } from '@/data/test/factories'
import { keysImmediatelyAfter, keysImmediatelyBefore } from './orderKeyPlacement'
import { keyBetween } from './orderKey'

// ──── fake tx harness ────

interface RecordedMove {
  id: string
  parentId: string | null
  orderKey: string
}

/** Minimal fake satisfying only the `Tx` surface orderKeyPlacement.ts
 *  actually reads: `move(id, {parentId, orderKey})`. Records every call so
 *  the oracles below can replay them against the sibling model. */
const makeFakeTx = (moves: RecordedMove[]): Tx => ({
  move: async (id: string, target: {parentId: string | null; orderKey: string}) => {
    moves.push({id, parentId: target.parentId, orderKey: target.orderKey})
  },
}) as unknown as Tx

// ──── sibling model ────

// Deliberate overrides vs the factory defaults: workspaceId 'ws' (factory
// requires it explicitly anyway) and createdBy/updatedBy 'u' (factory
// defaults to 'test-user') — this suite doesn't care about the actor id,
// just keeps it short and distinct from block ids in failure output.
const mkSibling = (id: string, parentId: string | null, orderKey: string): BlockData =>
  makeBlockData({id, workspaceId: 'ws', parentId, orderKey, createdBy: 'u', updatedBy: 'u'})

/** Builds a sibling list as a sequence of "buckets", each sharing one REAL
 *  fractional-indexing key (so `keysBetween`'s internal arithmetic — called
 *  by the code under test — always sees well-formed input, never an
 *  arbitrary string). Bucket sizes >1 create ties, including runs of 3+.
 *  Ids are assigned in ascending generation order, so the array is already
 *  in the `(order_key, id)` order the real contract requires — no separate
 *  sort needed. */
const buildSiblings = (bucketSizes: number[], parentId: string | null): BlockData[] => {
  const siblings: BlockData[] = []
  let key: string | null = null
  let idx = 0
  for (const size of bucketSizes) {
    key = keyBetween(key, null)
    for (let j = 0; j < size; j++) {
      siblings.push(mkSibling(`s${String(idx).padStart(3, '0')}`, parentId, key))
      idx++
    }
  }
  return siblings
}

const caseArb = fc.record({
  // Bucket sizes 1-4 (>1 → ties, up to a run of 4) across 1-6 buckets, so
  // total sibling counts range from a singleton list up to 24 rows with
  // several tie runs mixed in.
  bucketSizes: fc.array(fc.integer({min: 1, max: 4}), {minLength: 1, maxLength: 6}),
  // Reduced mod the built sibling length inside the property (length is
  // data-dependent, so it can't be bounded here) — this reaches head,
  // middle, and tail anchors, including mid-run positions inside a tie.
  anchorRaw: fc.nat(),
  n: fc.integer({min: 1, max: 4}),
  parentId: fc.constantFrom(null, 'parent-a'),
  prngSeed: fc.integer({min: 1, max: 2147483646}),
})

/** `(order_key, id)` order — orderKey.ts backs every key with plain base62
 *  strings compared via plain `<`/`>` (orderKey.test.ts's assertions all
 *  compare returned keys with bare `<`), and the id tiebreak is the
 *  documented secondary sort (`tx.childrenOf`, orderKey.ts:14-16's
 *  `<order_key>!hex(id)/` note). */
const byKeyThenId = (a: {orderKey: string; id: string}, b: {orderKey: string; id: string}): number => {
  if (a.orderKey !== b.orderKey) return a.orderKey < b.orderKey ? -1 : 1
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0
}

type Direction = 'before' | 'after'

const runPlacement = async (
  direction: Direction,
  siblings: BlockData[],
  parentId: string | null,
  anchor: number,
  n: number,
): Promise<{returned: string[]; moves: RecordedMove[]}> => {
  const moves: RecordedMove[] = []
  const tx = makeFakeTx(moves)
  const returned = direction === 'before'
    ? await keysImmediatelyBefore(tx, parentId, siblings, anchor, n)
    : await keysImmediatelyAfter(tx, parentId, siblings, anchor, n)
  return {returned, moves}
}

const checkOracles = (
  direction: Direction,
  siblings: BlockData[],
  parentId: string | null,
  anchor: number,
  n: number,
  returned: string[],
  moves: RecordedMove[],
): void => {
  const anchorId = siblings[anchor].id
  const origIds = new Set(siblings.map(s => s.id))

  // Oracle 1 — `n` returned keys, strictly ascending. orderKeyPlacement.ts
  // always slices the front of a `keysBetween(...)` gap (lines 42/57/73/88);
  // orderKey.test.ts:37-46 asserts `keysBetween` output is always strictly
  // ascending, so this should hold unconditionally.
  expect(returned).toHaveLength(n)
  for (let i = 1; i < returned.length; i++) expect(returned[i - 1] < returned[i]).toBe(true)

  // Oracle 2 — ids never dropped or duplicated by the recorded moves: every
  // moved id was an original sibling, and each is moved at most once (the
  // move loops walk a contiguous index range once per row —
  // orderKeyPlacement.ts:54-56, :85-87). Also — parentId passed to
  // `tx.move` is always the function's own `parentId` parameter (lines 55,
  // 86 pass it through verbatim), never something derived per-sibling.
  for (const mv of moves) {
    expect(origIds.has(mv.id)).toBe(true)
    expect(mv.parentId).toBe(parentId)
  }
  expect(new Set(moves.map(m => m.id)).size).toBe(moves.length)

  // Oracle 3 — no ties in the operation's own output. `returned` followed by
  // the moved keys in call order is exactly the `gap` array
  // orderKeyPlacement.ts builds from a single `keysBetween` call (lines
  // 53/84) and then slices/distributes — so the concatenation must be
  // strictly ascending end to end. This is the #198/#182/#188 bug class:
  // duplicate/tied keys surviving a tie-breaking placement.
  const gapReconstructed = [...returned, ...moves.map(m => m.orderKey)]
  for (let i = 1; i < gapReconstructed.length; i++) {
    expect(gapReconstructed[i - 1] < gapReconstructed[i]).toBe(true)
  }

  // Oracle 4 — "immediately before/after" (orderKeyPlacement.ts:28-31,
  // :60-63). Apply the recorded moves to the sibling model, insert the `n`
  // new ids at their returned keys, sort by `(order_key, id)`, and check the
  // new ids land as a contiguous block directly adjacent to the anchor's id
  // on the requested side, in the requested (ascending) order.
  const keyById = new Map(siblings.map(s => [s.id, s.orderKey]))
  for (const mv of moves) keyById.set(mv.id, mv.orderKey)
  const newIds = returned.map((_, i) => `new-${i}`)
  const finalEntries = [
    ...siblings.map(s => ({id: s.id, orderKey: keyById.get(s.id)!})),
    ...returned.map((k, i) => ({id: newIds[i], orderKey: k})),
  ]
  finalEntries.sort(byKeyThenId)
  const anchorPos = finalEntries.findIndex(e => e.id === anchorId)
  expect(anchorPos).toBeGreaterThanOrEqual(0)
  if (direction === 'before') {
    expect(finalEntries.slice(anchorPos - n, anchorPos).map(e => e.id)).toEqual(newIds)
  } else {
    expect(finalEntries.slice(anchorPos + 1, anchorPos + 1 + n).map(e => e.id)).toEqual(newIds)
  }
}

/** Interrupt-barrier + Math.random pin, shared across both properties
 *  below — see `statefulFuzzGuard` (`@/test/fuzz`, docs/fuzzing.md §6).
 *  The shared state here is global `Math.random` (no DB), but the
 *  barrier-before-pin ordering matters just the same: an abandoned
 *  case's `finally` would otherwise restore it over the next property's
 *  pin, breaking seeded replay. `afterAll` covers the LAST property's
 *  final case, which has no subsequent pre-case barrier of its own. */
const guard = statefulFuzzGuard()
afterAll(async () => { await guard.barrier() })

describe('orderKeyPlacement fuzz', () => {
  it('keysImmediatelyBefore: never throws; new keys ascending with no ties; ids preserved; land immediately before the anchor', async () => {
    await fc.assert(
      fc.asyncProperty(caseArb, ({bucketSizes, anchorRaw, n, parentId, prngSeed}) =>
        guard.run(prngSeed, async () => {
          const siblings = buildSiblings(bucketSizes, parentId)
          const anchor = anchorRaw % siblings.length
          const {returned, moves} = await runPlacement('before', siblings, parentId, anchor, n)
          checkOracles('before', siblings, parentId, anchor, n, returned, moves)
        })),
      fuzzParams(150),
    )
  })

  it('keysImmediatelyAfter: never throws; new keys ascending with no ties; ids preserved; land immediately after the anchor', async () => {
    await fc.assert(
      fc.asyncProperty(caseArb, ({bucketSizes, anchorRaw, n, parentId, prngSeed}) =>
        guard.run(prngSeed, async () => {
          const siblings = buildSiblings(bucketSizes, parentId)
          const anchor = anchorRaw % siblings.length
          const {returned, moves} = await runPlacement('after', siblings, parentId, anchor, n)
          checkOracles('after', siblings, parentId, anchor, n, returned, moves)
        })),
      fuzzParams(150),
    )
  })
})
