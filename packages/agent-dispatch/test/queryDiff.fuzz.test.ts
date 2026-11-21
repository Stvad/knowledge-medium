// @vitest-environment node
/**
 * Fuzz suite for `diffQueryRows` (src/queryDiff.ts:59-86) — the
 * union-cursor dedup that decides which query-watcher rows are "new"
 * (and therefore trigger a billed agent run). See `src/test/fuzz.ts` for
 * smoke/deep tier mechanics and `docs/fuzzing.md` for conventions. This
 * is the same target as the example-based tests in `watchers.test.ts`
 * (`describe('diffQueryRows', ...)`, lines 143-213) — read that file
 * first, this suite generalizes it with randomized batch sequences and
 * an independent reference model instead of hand-picked cases.
 *
 * `diffQueryRows` lives in `queryDiff.ts`, split out of `watchers.ts` so
 * this suite imports the pure logic WITHOUT `watchers.ts`'s `./config.js`
 * → `@knowledge-medium/agent-cli/*` chain (untracked dist, unresolvable
 * on a pre-build CI runner — see queryDiff.ts's header). It is pure and
 * synchronous — no DB, no `Math.random`, no `Date.now()` — so there is no
 * shared mutable state across fast-check cases and no `statefulFuzzGuard`
 * is needed (unlike the DB-backed stateful suites in
 * `src/data/test/*.fuzz.test.ts`).
 *
 * ──── Contract, grounded at the cited lines ────
 *
 * `diffQueryRows(rows, prevIds)` (queryDiff.ts:59-86):
 *  - rows without a usable string `id` are dropped and counted in
 *    `invalidRows` (:23-27, :62-66) — not exercised by name here,
 *    already covered by `watchers.test.ts:208-212`; this suite only
 *    generates rows with a valid `id`.
 *  - a `valid.length > MAX_CURSOR_IDS` result set is refused outright:
 *    `newRows: []`, cursor untouched (:68-70) — already covered by
 *    `watchers.test.ts:192-206`; not re-exercised here (this suite's
 *    small id universe can never reach the cap on its own; property 2
 *    below constructs an oversized-*cursor*, not an oversized *rows*
 *    array, which is a different code path).
 *  - `prevIds === null` is the first-run baseline: establishes the
 *    cursor from the current valid ids WITHOUT firing (:72-74).
 *  - otherwise `newRows` is exactly the valid rows whose id is not in
 *    the `prevIds` set (:76-77), and the returned cursor is the union
 *    `prevIds ∪ currentIds`, with currently-visible ids placed LAST so
 *    that truncation to `MAX_CURSOR_IDS` (:84) only ever drops ids that
 *    have left the result set (:78-84 comment + implementation) —
 *    "Oldest ids are forgotten past this" (:39-41 doc comment on
 *    `MAX_CURSOR_IDS`).
 *
 * ──── Properties ────
 *
 * 1. Sequential small-universe property: a fixed 10-30 id universe run
 *    through a short sequence of overlapping/rotating batches (so ids
 *    churn in and out like a LIMIT-windowed or re-ordered query), diffed
 *    against the REAL cursor threaded from call to call, alongside an
 *    INDEPENDENT `Set<string>` "ever-seen" mirror maintained purely in
 *    the test (not derived from the function's own dedup logic). Per
 *    step:
 *      (a) first call -> `newRows === []` (baseline, :72-74). A false
 *          positive here would replay a watcher's entire backlog as new
 *          triggers on first tick.
 *      (b) `newRows` (as an id set) === this batch's ids MINUS the
 *          independent mirror (:76-77) — checked as an exact set
 *          equality (not a subset check), so it catches BOTH directions:
 *          an id present that shouldn't be = a duplicate billed run; an
 *          id missing that should be there = a missed trigger.
 *      (c) every currently-visible id survives into `diff.seenIds`
 *          (:78-84) — the anti-re-fire/anti-re-bill invariant: losing
 *          a visible id here re-fires (and re-bills) it on the very next
 *          poll.
 *      (d) `diff.seenIds.length <= MAX_CURSOR_IDS` always holds (trivial
 *          at this universe size — real eviction is exercised by
 *          property 2).
 * 2. Eviction-preference property: directly targets the `MAX_CURSOR_IDS`
 *    doc claim ("oldest ids are forgotten", :39-41) that property 1's
 *    small universe can never reach. Builds a `prevIds` cursor of
 *    EXACTLY `MAX_CURSOR_IDS` ids: an `old-*` prefix (won't appear in
 *    this step's rows) followed by a `keep-*` suffix (will still be
 *    visible). Rows = the `keep-*` ids plus a batch of brand-new ids.
 *    Asserts the cursor stays exactly at the cap, every visible id
 *    (kept + new) survives, and the evicted ids are EXACTLY the oldest
 *    `newRowsCount` ids of the `old-*` prefix — computed independently
 *    via prefix/suffix slicing reasoned from the doc comment's FIFO
 *    claim, not by re-deriving the target's own
 *    `.slice(-MAX_CURSOR_IDS)` mechanics. A false 'new' among kept ids =
 *    duplicate billed run; an evicted `keep-*`/new id = missed trigger
 *    next poll; a non-FIFO eviction choice would silently violate the
 *    documented "forgets oldest first" contract without either example
 *    test noticing (both fixed cases in watchers.test.ts only ever
 *    evict from a single contiguous `old-*` block).
 */
import { describe, expect, it } from 'vitest'
import fc from 'fast-check'
import { fuzzParams, fuzzTestTimeout } from '@/test/fuzz'
import { diffQueryRows, MAX_CURSOR_IDS } from '../src/queryDiff'

// ──── property 1: small-universe sequential churn ────

/** A batch of "rows" for one poll: a subarray of the shared universe
 *  (unique ids, order-preserving — like a real query result), turned
 *  into minimal `{id}` rows (extra fields aren't relevant to any of the
 *  oracles here; `rowId` only reads `.id`, queryDiff.ts:23-27). */
const batchesArb = fc.integer({min: 10, max: 30}).chain(universeSize => {
  const universe = Array.from({length: universeSize}, (_, i) => `id-${i}`)
  return fc.array(fc.subarray(universe), {minLength: 1, maxLength: 15})
})

describe('diffQueryRows — sequential churn over a small id universe', () => {
  it('newRows tracks an independent ever-seen mirror; visible ids never evicted; cursor stays bounded (queryDiff.ts:59-86)', () => {
    fc.assert(
      fc.property(batchesArb, batches => {
        let prevIds: string[] | null = null
        const everSeen = new Set<string>()

        for (const batch of batches) {
          const rows = batch.map(id => ({id}))
          const diff = diffQueryRows(rows, prevIds)

          if (prevIds === null) {
            // (a) first-run baseline never fires (queryDiff.ts:72-74).
            expect(diff.newRows).toEqual([])
          } else {
            // (b) exact set equality against the independent mirror
            // (queryDiff.ts:76-77) — catches false-new AND lost-new.
            const expectedNew = new Set(batch.filter(id => !everSeen.has(id)))
            expect(new Set(diff.newRows.map(row => row.id))).toEqual(expectedNew)
            expect(diff.newRows.length).toBe(expectedNew.size)
          }

          // (c) every currently-visible id survives the cursor — the
          // anti-re-fire/anti-re-bill invariant (queryDiff.ts:78-84).
          const seenSet = new Set(diff.seenIds)
          for (const id of batch) expect(seenSet.has(id)).toBe(true)

          // (d) cursor never exceeds the retention bound (queryDiff.ts:42,
          // vacuous at this universe size — property 2 forces real
          // eviction).
          expect(diff.seenIds.length).toBeLessThanOrEqual(MAX_CURSOR_IDS)

          for (const id of batch) everSeen.add(id)
          prevIds = diff.seenIds
        }
      }),
      fuzzParams(150),
    )
  }, fuzzTestTimeout())
})

// ──── property 2: eviction preference at the MAX_CURSOR_IDS boundary ────

/** `keepCount` ids that stay visible this step (protected from
 *  eviction), `newCount` brand-new ids (also visible, also protected),
 *  and enough `old-*` filler to make `prevIds` exactly `MAX_CURSOR_IDS`
 *  long so the union with `newCount` fresh ids forces eviction of
 *  exactly `newCount` entries. */
const evictionCaseArb = fc.record({
  keepCount: fc.integer({min: 0, max: 20}),
  newCount: fc.integer({min: 1, max: 20}),
})

describe('diffQueryRows — eviction preference under MAX_CURSOR_IDS overflow', () => {
  it('evicts exactly the oldest non-visible ids, keeps every visible id, and holds the cursor at the cap (queryDiff.ts:39-41, 78-84)', () => {
    fc.assert(
      fc.property(evictionCaseArb, ({keepCount, newCount}) => {
        const oldCount = MAX_CURSOR_IDS - keepCount
        const oldIds = Array.from({length: oldCount}, (_, i) => `old-${i}`)
        const keepIds = Array.from({length: keepCount}, (_, i) => `keep-${i}`)
        const prevIds = [...oldIds, ...keepIds]
        expect(prevIds.length).toBe(MAX_CURSOR_IDS)

        const newIds = Array.from({length: newCount}, (_, i) => `new-${i}`)
        const rows = [...keepIds, ...newIds].map(id => ({id}))

        const diff = diffQueryRows(rows, prevIds)

        // Bound holds exactly at the cap (old+keep already at cap, plus
        // newCount more visible ids forces eviction of newCount olds).
        expect(diff.seenIds.length).toBe(MAX_CURSOR_IDS)

        const seenSet = new Set(diff.seenIds)
        // Every visible id (kept + brand-new) survives — anti-re-fire
        // invariant re-checked right at the cap boundary.
        for (const id of keepIds) expect(seenSet.has(id)).toBe(true)
        for (const id of newIds) expect(seenSet.has(id)).toBe(true)
        // newRows is exactly the brand-new ids (kept ids were already seen).
        expect(new Set(diff.newRows.map(row => row.id))).toEqual(new Set(newIds))

        // Eviction preference: independently reasoned from the doc
        // comment's FIFO claim (:39-41) — the oldest `newCount` ids of
        // the non-visible `old-*` prefix are dropped, the newer `old-*`
        // suffix survives. NOT re-deriving the target's own
        // `.slice(-MAX_CURSOR_IDS)` call. `oldIds` has no duplicates, so
        // a single equality on the (small, size-`newCount`) actually-
        // evicted subsequence pins the whole prefix/suffix split — no
        // need to assert membership one-by-one over the ~20k survivors.
        const actuallyEvicted = oldIds.filter(id => !seenSet.has(id))
        expect(actuallyEvicted).toEqual(oldIds.slice(0, newCount))
      }),
      // Each case allocates several MAX_CURSOR_IDS (20k)-length arrays —
      // keep smoke runs moderate so the file stays within its ~1s
      // wall-time budget (docs/fuzzing.md "Adding a suite" step 2); the
      // `{keepCount, newCount}` input space is small (20*20) so this
      // still gets reasonable smoke coverage, and deep mode
      // (`FUZZ_TIME_MS`) explores it exhaustively regardless of this N.
      fuzzParams(40),
    )
  }, fuzzTestTimeout())
})
