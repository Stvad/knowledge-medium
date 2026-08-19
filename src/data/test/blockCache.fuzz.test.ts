// @vitest-environment node
/**
 * Stateful fuzz suite for `BlockCache` (`src/data/blockCache.ts`) — a
 * plain-object model differential over the documented per-id cache rules.
 * See `src/test/fuzz.ts` for smoke/deep tier mechanics and
 * `docs/fuzzing.md` for conventions.
 *
 * `BlockCache` is pure in-memory state (`Map`/`Set`, `blockCache.ts:93-104`)
 * with no `Math.random`/`Date.now()` in its own code (verified: the only
 * `Date.now()` hit in the file is inside a doc comment at :165, not code) —
 * so no `statefulFuzzGuard`/pinned-random is needed; a fresh `BlockCache`
 * per case is enough.
 *
 * ──── Semantics grounding (blockCache.ts) ────
 *
 * - `setSnapshot` (:126-148): unconditional write, deep-equal (`lodash-es`
 *   `isEqual`) dedup against the existing entry — a no-op (no write, no
 *   notify, `dedupHits++`) iff the incoming snapshot is deep-equal to what's
 *   cached; otherwise writes + deep-freezes + clears any missing marker +
 *   notifies (`dedupMisses++`, `notifies++`) and returns `true`.
 * - `applyIfNewer` (:179-189) — the LWW gate: rejects (`false`, no write) an
 *   incoming snapshot whose `updatedAt` is NOT STRICTLY NEWER than the
 *   cached one (`snapshot.updatedAt <= existing.updatedAt`, :183, STRICT
 *   `<=` per the docblock at :164-174 — a same-ms collision must not
 *   clobber). No existing entry skips the gate entirely and falls through
 *   to `setSnapshot`. `source` (:180-181, :184-185) only routes which
 *   `applyIfNewer{Sync,Hydrate}{Calls,Rejected}` counters move — the gate
 *   itself is identical for both.
 * - `deleteSnapshot` (:191-196): `Map.delete`'s own return value gates the
 *   notify — no-op (`false`) if nothing was cached.
 * - `markMissing` (:244-251): drops any cached snapshot as part of the
 *   transition (so the snapshot/missing invariant below can never be
 *   violated by this call) and is a no-op (`false`, no notify) ONLY when
 *   the id was already marked missing AND had no snapshot to clear
 *   (`hadMarker && !hadSnapshot`); every other case (fresh mark, or
 *   clearing a leftover snapshot while already marked) adds the marker and
 *   notifies once.
 * - `clearMissing` (:265-269): `Set.delete`'s return value gates the
 *   notify.
 * - Invariant asserted throughout (stated at :98 and re-derived from the
 *   above): a given id is never BOTH `hasSnapshot` and `isMissing` at once
 *   — `setSnapshot`/`applyIfNewer` clear the missing marker (:145),
 *   `markMissing` clears the snapshot (:246).
 * - `subscribe`/`trackedIds` (:198-219): per-id listener bucket backed by
 *   `CallbackSet`; unsubscribing down to zero listeners for an id drops the
 *   bucket (identity-guarded against a stale unsub after a re-subscribe,
 *   :211), so `trackedIds()` is exactly "ids with >=1 active listener" —
 *   and unsubscribe is idempotent (`CallbackSet.add`'s returned closure
 *   just does `Set.delete`, safe to call twice).
 * - `metrics` (`BlockCacheMetrics`, :25-78) is public, directly-readable
 *   state, incremented inline at each site cited above — an observable
 *   surface, not an implementation reformulation once modeled from the
 *   docblock rules rather than by re-deriving from the source line-by-line.
 *
 * ──── Properties ────
 *
 * 1. Model differential: random op sequences (`setSnapshot`,
 *    `applyIfNewer` with both sources, `deleteSnapshot`, `markMissing`,
 *    `clearMissing`) over a 3-id / 4-stamp / 2-content alphabet (small
 *    enough that same-stamp and same-(content,stamp) collisions are
 *    frequent, exercising both the dedup path and the LWW gate's boundary).
 *    After every op: cache state (`getSnapshot`/`hasSnapshot`/`isMissing`/
 *    `requireSnapshot`) matches an independent plain-object model for every
 *    id in the alphabet (not just the touched one — catches cross-id
 *    contamination), the never-both invariant holds, cached snapshots are
 *    frozen, and every `metrics` counter matches a model-tracked count.
 * 2. Subscribe/unsubscribe lifecycle: random interleaving of `subscribe`,
 *    unsubscribe-by-index (including deliberately re-picking an
 *    already-unsubscribed index, to hit the idempotence path), and cache
 *    mutations. Oracle: `trackedIds()` always equals the model's "ids with
 *    >= 1 active listener" set, and each listener's own observed call
 *    count equals the number of notifying mutations that landed on its id
 *    while it was active — an exact per-listener notify-fan-out check, not
 *    just a totals check.
 */
import { describe, expect, it } from 'vitest'
import fc from 'fast-check'
import { fuzzParams, fuzzTestTimeout } from '@/test/fuzz'
import { BlockCache, type ApplyIfNewerSource } from '@/data/blockCache'
import type { BlockData } from '@/data/api'

const IDS = ['a', 'b', 'c'] as const
type Id = (typeof IDS)[number]
const STAMPS = [0, 1, 2, 3] as const
// Small content alphabet so distinct ops frequently produce deep-equal
// snapshots (same content + same stamp) and exercise setSnapshot's dedup.
const CONTENTS = ['x', 'y'] as const

/** All non-(content,updatedAt) fields are held constant per call, so two
 *  snapshots for the same id are deep-equal (for `setSnapshot`'s dedup) iff
 *  their (content, updatedAt) pairs match — keeps the model's equality
 *  check a plain tuple comparison instead of reimplementing `isEqual`. */
const mkSnapshot = (id: Id, content: string, updatedAt: number): BlockData => ({
  id,
  workspaceId: 'ws',
  parentId: null,
  orderKey: 'a',
  content,
  properties: {},
  references: [],
  createdAt: 0,
  updatedAt,
  userUpdatedAt: updatedAt,
  createdBy: 'u',
  updatedBy: 'u',
  deleted: false,
})

const idArb = fc.constantFrom(...IDS)
const stampArb = fc.constantFrom(...STAMPS)
const contentArb = fc.constantFrom(...CONTENTS)
const sourceArb: fc.Arbitrary<ApplyIfNewerSource> = fc.constantFrom('sync', 'hydrate')

// ──── Property 1: model differential ────

type Op =
  | {kind: 'set'; id: Id; content: string; updatedAt: number}
  | {kind: 'applyIfNewer'; id: Id; content: string; updatedAt: number; source: ApplyIfNewerSource}
  | {kind: 'delete'; id: Id}
  | {kind: 'markMissing'; id: Id}
  | {kind: 'clearMissing'; id: Id}

const opArb: fc.Arbitrary<Op> = fc.oneof(
  fc.record({kind: fc.constant('set' as const), id: idArb, content: contentArb, updatedAt: stampArb}),
  fc.record({
    kind: fc.constant('applyIfNewer' as const),
    id: idArb,
    content: contentArb,
    updatedAt: stampArb,
    source: sourceArb,
  }),
  fc.record({kind: fc.constant('delete' as const), id: idArb}),
  fc.record({kind: fc.constant('markMissing' as const), id: idArb}),
  fc.record({kind: fc.constant('clearMissing' as const), id: idArb}),
)

const opsArb = fc.array(opArb, {minLength: 1, maxLength: 25})

interface ModelEntry {
  content: string
  updatedAt: number
}

interface Model {
  snapshots: Map<Id, ModelEntry>
  missing: Set<Id>
}

interface MetricsModel {
  setSnapshotCalls: number
  setSnapshotDedupHits: number
  setSnapshotDedupMisses: number
  applyIfNewerSyncCalls: number
  applyIfNewerSyncRejected: number
  applyIfNewerHydrateCalls: number
  applyIfNewerHydrateRejected: number
  notifies: number
}

const zeroMetrics = (): MetricsModel => ({
  setSnapshotCalls: 0,
  setSnapshotDedupHits: 0,
  setSnapshotDedupMisses: 0,
  applyIfNewerSyncCalls: 0,
  applyIfNewerSyncRejected: 0,
  applyIfNewerHydrateCalls: 0,
  applyIfNewerHydrateRejected: 0,
  notifies: 0,
})

/** Mirrors `setSnapshot` (blockCache.ts:126-148). Returns whether the write
 *  landed (and thus notified) — the same signal `notified` callers below
 *  use to drive property 2's per-listener expectations. */
const modelSetSnapshot = (
  model: Model, metrics: MetricsModel, id: Id, content: string, updatedAt: number,
): boolean => {
  metrics.setSnapshotCalls++
  const existing = model.snapshots.get(id)
  if (existing && existing.content === content && existing.updatedAt === updatedAt) {
    metrics.setSnapshotDedupHits++
    return false
  }
  metrics.setSnapshotDedupMisses++
  model.snapshots.set(id, {content, updatedAt})
  model.missing.delete(id)
  metrics.notifies++
  return true
}

/** Mirrors `applyIfNewer` (blockCache.ts:179-189) — the LWW gate. */
const modelApplyIfNewer = (
  model: Model, metrics: MetricsModel, id: Id, content: string, updatedAt: number,
  source: ApplyIfNewerSource,
): boolean => {
  if (source === 'sync') metrics.applyIfNewerSyncCalls++
  else metrics.applyIfNewerHydrateCalls++
  const existing = model.snapshots.get(id)
  if (existing && updatedAt <= existing.updatedAt) {
    if (source === 'sync') metrics.applyIfNewerSyncRejected++
    else metrics.applyIfNewerHydrateRejected++
    return false
  }
  return modelSetSnapshot(model, metrics, id, content, updatedAt)
}

/** Mirrors `deleteSnapshot` (blockCache.ts:191-196). */
const modelDelete = (model: Model, metrics: MetricsModel, id: Id): boolean => {
  if (!model.snapshots.delete(id)) return false
  metrics.notifies++
  return true
}

/** Mirrors `markMissing` (blockCache.ts:244-251). */
const modelMarkMissing = (model: Model, metrics: MetricsModel, id: Id): boolean => {
  const hadMarker = model.missing.has(id)
  const hadSnapshot = model.snapshots.delete(id)
  if (hadMarker && !hadSnapshot) return false
  model.missing.add(id)
  metrics.notifies++
  return true
}

/** Mirrors `clearMissing` (blockCache.ts:265-269). */
const modelClearMissing = (model: Model, metrics: MetricsModel, id: Id): boolean => {
  if (!model.missing.delete(id)) return false
  metrics.notifies++
  return true
}

describe('BlockCache', () => {
  it('matches a plain-object model of the documented cache rules (blockCache.ts:126-269)', () => {
    fc.assert(
      fc.property(opsArb, ops => {
        const cache = new BlockCache()
        const model: Model = {snapshots: new Map(), missing: new Set()}
        const metrics = zeroMetrics()

        for (const op of ops) {
          let actual: boolean
          let expected: boolean
          switch (op.kind) {
            case 'set': {
              actual = cache.setSnapshot(mkSnapshot(op.id, op.content, op.updatedAt))
              expected = modelSetSnapshot(model, metrics, op.id, op.content, op.updatedAt)
              break
            }
            case 'applyIfNewer': {
              actual = cache.applyIfNewer(mkSnapshot(op.id, op.content, op.updatedAt), op.source)
              expected = modelApplyIfNewer(model, metrics, op.id, op.content, op.updatedAt, op.source)
              break
            }
            case 'delete': {
              actual = cache.deleteSnapshot(op.id)
              expected = modelDelete(model, metrics, op.id)
              break
            }
            case 'markMissing': {
              actual = cache.markMissing(op.id)
              expected = modelMarkMissing(model, metrics, op.id)
              break
            }
            case 'clearMissing': {
              actual = cache.clearMissing(op.id)
              expected = modelClearMissing(model, metrics, op.id)
              break
            }
          }
          expect(actual).toBe(expected)

          // Per-id state matches the model for EVERY id in the alphabet,
          // not just the touched one (blockCache.ts:106-120, :255-257).
          for (const id of IDS) {
            const modelEntry = model.snapshots.get(id)
            const actualSnap = cache.getSnapshot(id)
            if (modelEntry === undefined) {
              expect(actualSnap).toBeUndefined()
              expect(cache.hasSnapshot(id)).toBe(false)
              expect(() => cache.requireSnapshot(id)).toThrow()
            } else {
              const expectedSnap = mkSnapshot(id, modelEntry.content, modelEntry.updatedAt)
              expect(actualSnap).toEqual(expectedSnap)
              // setSnapshot deep-freezes every write (blockCache.ts:5-13, :143).
              expect(Object.isFrozen(actualSnap)).toBe(true)
              expect(cache.hasSnapshot(id)).toBe(true)
              expect(cache.requireSnapshot(id)).toEqual(expectedSnap)
            }
            expect(cache.isMissing(id)).toBe(model.missing.has(id))
            // Never-both invariant (blockCache.ts:98, :145, :246).
            expect(cache.hasSnapshot(id) && cache.isMissing(id)).toBe(false)
          }

          // Metrics counters match the model's tracked counts exactly.
          expect(cache.metrics.snapshot()).toEqual(metrics)
        }
      }),
      fuzzParams(200),
    )
  }, fuzzTestTimeout())

  // ──── Property 2: subscribe/unsubscribe lifecycle ────

  type LifecycleOp =
    | {kind: 'subscribe'; id: Id}
    | {kind: 'unsubscribe'; pick: number}
    | {kind: 'mutate'; id: Id; content: string; updatedAt: number; variant: 'set' | 'markMissing' | 'clearMissing'}

  const lifecycleOpArb: fc.Arbitrary<LifecycleOp> = fc.oneof(
    fc.record({kind: fc.constant('subscribe' as const), id: idArb}),
    // `pick` is reduced mod the current listener count at apply time (see
    // below) — an out-of-range value here deliberately lands on an already
    // -unsubscribed index sometimes, exercising idempotence.
    fc.record({kind: fc.constant('unsubscribe' as const), pick: fc.nat({max: 50})}),
    fc.record({
      kind: fc.constant('mutate' as const),
      id: idArb,
      content: contentArb,
      updatedAt: stampArb,
      variant: fc.constantFrom('set' as const, 'markMissing' as const, 'clearMissing' as const),
    }),
  )

  const lifecycleOpsArb = fc.array(lifecycleOpArb, {minLength: 1, maxLength: 25})

  interface ListenerRecord {
    id: Id
    observedCount: number
    expectedCount: number
    active: boolean
    off: () => void
  }

  it('trackedIds() and per-listener notify counts stay exact under interleaved subscribe/unsubscribe (blockCache.ts:198-219)', () => {
    fc.assert(
      fc.property(lifecycleOpsArb, ops => {
        const cache = new BlockCache()
        // Lightweight model reused only to detect whether a mutation
        // notified (same rules as property 1's model functions).
        const model: Model = {snapshots: new Map(), missing: new Set()}
        const metrics = zeroMetrics()
        const records: ListenerRecord[] = []
        const activeByid = new Map<Id, Set<number>>(IDS.map(id => [id, new Set<number>()]))

        for (const op of ops) {
          if (op.kind === 'subscribe') {
            const idx = records.length
            const rec: ListenerRecord = {id: op.id, observedCount: 0, expectedCount: 0, active: true, off: () => {}}
            rec.off = cache.subscribe(op.id, () => { rec.observedCount++ })
            records.push(rec)
            activeByid.get(op.id)!.add(idx)
          } else if (op.kind === 'unsubscribe') {
            if (records.length > 0) {
              const idx = op.pick % records.length
              const rec = records[idx]
              rec.off()
              if (rec.active) {
                rec.active = false
                activeByid.get(rec.id)!.delete(idx)
              }
            }
          } else {
            let notified: boolean
            if (op.variant === 'set') {
              notified = modelSetSnapshot(model, metrics, op.id, op.content, op.updatedAt)
              cache.setSnapshot(mkSnapshot(op.id, op.content, op.updatedAt))
            } else if (op.variant === 'markMissing') {
              notified = modelMarkMissing(model, metrics, op.id)
              cache.markMissing(op.id)
            } else {
              notified = modelClearMissing(model, metrics, op.id)
              cache.clearMissing(op.id)
            }
            if (notified) {
              for (const idx of activeByid.get(op.id)!) records[idx].expectedCount++
            }
          }

          // trackedIds() is exactly "ids with >= 1 active listener"
          // (blockCache.ts:198-219, the size===0 identity-guarded delete).
          const expectedTracked = new Set(IDS.filter(id => activeByid.get(id)!.size > 0))
          expect(cache.trackedIds()).toEqual(expectedTracked)
        }

        // Exact per-listener fan-out, not just a per-id total.
        for (const rec of records) {
          expect(rec.observedCount).toBe(rec.expectedCount)
        }
      }),
      fuzzParams(200),
    )
  }, fuzzTestTimeout())
})
