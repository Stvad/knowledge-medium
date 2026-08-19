// @vitest-environment node
/**
 * Fuzz suite for `replayApplicationOrder` (txSnapshots.ts:87-130) — the
 * undo/redo replay ordering that keeps the parent-liveness trigger happy at
 * every intermediate statement, not just in the end state. See
 * `src/test/fuzz.ts` for smoke/deep tier mechanics, `docs/fuzzing.md` for
 * conventions, and `txSnapshots.test.ts` for the pinned example cases this
 * suite generalizes (deep-chain stack safety, the cyclic-graph example).
 *
 * ──── Contract, grounded at the target (txSnapshots.ts:71-97) ────
 *
 * `replayApplicationOrder(snapshots, direction)` reads, per id, the
 * `direction`-side target (`before` or `after`). A target is EXEMPT
 * (tombstone/remove — trigger's WHEN clause doesn't apply, :95) when it is
 * `null` or `.deleted`; otherwise it's LIVE. Live entries are sorted
 * parents-first via a memoized depth walk restricted to ids that are BOTH
 * in this entry AND live in this direction (:116-117 — `live.has(parentId)`
 * gates the walk, so a parent outside the entry, or exempt in this
 * direction, ends the chain and needs no ordering per the docblock at
 * :78-79). Exempt entries are appended unconditionally after the sorted
 * live ones (:126-129) — that concatenation doesn't depend on acyclicity,
 * so it holds even in the pathological cyclic case. The depth walk's
 * `onPath` cycle guard (:113) makes a cyclic live subgraph terminate
 * (depth 0 at the re-entered node) rather than infinite-loop or stack
 * overflow — documented as best-effort, not order-preserving, at :102-104.
 *
 * ──── Properties ────
 *
 * 1. Conservation: output contains every input id exactly once, for both
 *    directions, on arbitrary (possibly cyclic/self-referential/
 *    disconnected) target graphs.
 * 2. Topological soundness: restricted to snapshot maps whose parent
 *    pointers are acyclic-by-construction (every id's `parentId`, in BOTH
 *    `before` and `after`, only ever names a strictly-earlier id in a fixed
 *    order — so neither direction's live subgraph can cycle) — for every
 *    live (id, target) pair whose target.parentId also has a live entry in
 *    this direction, the parent's output index precedes the child's.
 * 3. Exempt-last: no live entry ever appears after an exempt one in the
 *    output, for either direction — holds unconditionally (:126-129 is a
 *    plain concatenation), so this uses the same unconstrained generator as
 *    property 1.
 * 4. Totality: never throws on cyclic/self-referential/disconnected parent
 *    graphs, and still conserves ids — the cyclic case is documented
 *    best-effort (:102-104), so this property asserts termination +
 *    conservation only, not topological order.
 */
import { describe, expect, it } from 'vitest'
import fc from 'fast-check'
import { fuzzParams, fuzzTestTimeout } from '@/test/fuzz'
import type { BlockData } from '@/data/api'
import { newSnapshotsMap, replayApplicationOrder, type SnapshotsMap } from './txSnapshots.ts'

const DIRECTIONS = ['before', 'after'] as const

const block = (id: string, parentId: string | null, deleted: boolean): BlockData => ({
  id,
  workspaceId: 'ws',
  parentId,
  orderKey: 'a0',
  content: '',
  properties: {},
  references: [],
  createdAt: 0,
  updatedAt: 0,
  userUpdatedAt: 0,
  createdBy: 'u',
  updatedBy: 'u',
  deleted,
})

const ID_POOL = Array.from({length: 8}, (_, i) => `n${i}`)
/** Deliberately outside ID_POOL: never a key in a generated snapshots map,
 *  so a parentId pointing here always hits the "parent not in this entry"
 *  no-ordering-needed case (docblock :78-79). */
const UNKNOWN_PARENT = 'zz-unknown'

const buildMap = (ids: readonly string[], entries: readonly {before: BlockData | null, after: BlockData | null}[]): SnapshotsMap => {
  const map = newSnapshotsMap()
  ids.forEach((id, i) => map.set(id, entries[i]))
  return map
}

// ──── Property 1 / 3 / 4 generator: unconstrained parent pointers ────
// (any pool id, including self — so self-loops and cycles arise naturally).

const freeTargetArb = (id: string, idPool: readonly string[]): fc.Arbitrary<BlockData | null> =>
  fc.oneof(
    {weight: 1, arbitrary: fc.constant(null)},
    {
      weight: 4,
      arbitrary: fc
        .record({
          parentId: fc.oneof(
            {weight: 1, arbitrary: fc.constant(null)},
            {weight: 1, arbitrary: fc.constant(UNKNOWN_PARENT)},
            {weight: 4, arbitrary: fc.constantFrom(...idPool)},
          ),
          deleted: fc.boolean(),
        })
        .map(({parentId, deleted}) => block(id, parentId, deleted)),
    },
  )

const generalSnapshotsArb: fc.Arbitrary<SnapshotsMap> = fc
  .subarray(ID_POOL, {minLength: 1})
  .chain(ids =>
    fc
      .tuple(...ids.map(id => fc.record({before: freeTargetArb(id, ID_POOL), after: freeTargetArb(id, ID_POOL)})))
      .map(entries => buildMap(ids, entries)),
  )

// ──── Property 2 generator: acyclic-by-construction parent pointers ────
// Each id at fixed index i may only point (in EITHER before or after) to an
// earlier-index id, null, or the unknown/disconnected id — so a chain of
// live parent pointers strictly decreases index and can never cycle, in
// either direction, matching the "well-formed input doesn't cycle" case
// property 4 deliberately steps outside of.

const acyclicTargetArb = (id: string, ids: readonly string[], i: number): fc.Arbitrary<BlockData | null> => {
  const parentIdArb: fc.Arbitrary<string | null> = i === 0
    ? fc.constantFrom(null, UNKNOWN_PARENT)
    : fc.oneof(
        {weight: 1, arbitrary: fc.constant(null)},
        {weight: 1, arbitrary: fc.constant(UNKNOWN_PARENT)},
        {weight: 4, arbitrary: fc.constantFrom(...ids.slice(0, i))},
      )
  return fc.oneof(
    {weight: 1, arbitrary: fc.constant(null)},
    {
      weight: 4,
      arbitrary: fc.record({parentId: parentIdArb, deleted: fc.boolean()})
        .map(({parentId, deleted}) => block(id, parentId, deleted)),
    },
  )
}

const acyclicSnapshotsArb: fc.Arbitrary<SnapshotsMap> = fc.integer({min: 1, max: 8}).chain(size => {
  const ids = ID_POOL.slice(0, size)
  return fc
    .tuple(...ids.map((id, i) => fc.record({
      before: acyclicTargetArb(id, ids, i),
      after: acyclicTargetArb(id, ids, i),
    })))
    .map(entries => buildMap(ids, entries))
})

describe('replayApplicationOrder', () => {
  it('conserves every input id exactly once, in both replay directions (txSnapshots.ts:87-97, 125-129)', () => {
    fc.assert(
      fc.property(generalSnapshotsArb, snapshots => {
        for (const direction of DIRECTIONS) {
          const ids = replayApplicationOrder(snapshots, direction).map(([id]) => id)
          expect(new Set(ids).size).toBe(ids.length)
          expect([...ids].sort()).toEqual([...snapshots.keys()].sort())
        }
      }),
      fuzzParams(300),
    )
  }, fuzzTestTimeout())

  it('orders a live parent before its live child when the target graph is acyclic (txSnapshots.ts:71-78, 91-97, 105-125)', () => {
    fc.assert(
      fc.property(acyclicSnapshotsArb, snapshots => {
        for (const direction of DIRECTIONS) {
          const result = replayApplicationOrder(snapshots, direction)
          const indexOf = new Map(result.map(([id], idx) => [id, idx] as const))
          for (const [id, snap] of snapshots) {
            const target = snap[direction]
            if (target === null || target.deleted) continue // not live: no ordering claim
            const parentId = target.parentId
            if (parentId == null) continue
            const parentSnap = snapshots.get(parentId)
            if (!parentSnap) continue // parent outside the entry: no ordering needed (:78-79)
            const parentTarget = parentSnap[direction]
            if (parentTarget === null || parentTarget.deleted) continue // parent not live here
            expect(indexOf.get(parentId)).toBeLessThan(indexOf.get(id)!)
          }
        }
      }),
      fuzzParams(300),
    )
  }, fuzzTestTimeout())

  it('never places a live target after an exempt (null/tombstoned) one (txSnapshots.ts:91-97, 126-129)', () => {
    fc.assert(
      fc.property(generalSnapshotsArb, snapshots => {
        for (const direction of DIRECTIONS) {
          const result = replayApplicationOrder(snapshots, direction)
          let seenExempt = false
          for (const [, target] of result) {
            const isExempt = target === null || target.deleted
            if (isExempt) seenExempt = true
            else expect(seenExempt).toBe(false)
          }
        }
      }),
      fuzzParams(300),
    )
  }, fuzzTestTimeout())

  it('never throws and still conserves ids on cyclic/self-referential/disconnected parent graphs (txSnapshots.ts:98-124, documented best-effort)', () => {
    fc.assert(
      fc.property(generalSnapshotsArb, snapshots => {
        for (const direction of DIRECTIONS) {
          let result: Array<[string, BlockData | null]> | undefined
          expect(() => { result = replayApplicationOrder(snapshots, direction) }).not.toThrow()
          const ids = result!.map(([id]) => id)
          expect([...ids].sort()).toEqual([...snapshots.keys()].sort())
        }
      }),
      fuzzParams(300),
    )
  }, fuzzTestTimeout())
})
