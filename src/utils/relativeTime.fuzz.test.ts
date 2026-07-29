// @vitest-environment node
/**
 * Fuzz suite for `formatRelativeTime` (src/utils/relativeTime.ts:14-27). See
 * `src/test/fuzz.ts` for the smoke/deep tier mechanics and `docs/fuzzing.md`
 * for conventions.
 *
 * ──── Contract under test (relativeTime.ts:14-27) ────
 *
 * `formatRelativeTime(ts, now)`:
 *  - guards `!ts || !now` (:15) — a falsy `ts` (0/NaN) OR a falsy `now`
 *    (0/NaN) returns `''`, regardless of the other argument.
 *  - otherwise `sec = floor((now - ts) / 1000)` (:16); a negative `sec`
 *    (clock skew — `ts` slightly ahead of `now`) falls into the same
 *    `sec < MINUTE` branch as a genuinely-recent timestamp, so it also
 *    collapses to `'just now'` (:17) — there's no separate future-clamp.
 *  - `sec < MINUTE(60)` → `'just now'` (:17)
 *  - `sec < HOUR(3600)` → `` `${floor(sec/60)}m ago` `` (:18)
 *  - `sec < DAY(86400)` → `` `${floor(sec/3600)}h ago` `` (:19)
 *  - `days = floor(sec/86400)`; `days < 7` → `` `${days}d ago` `` (:20-21)
 *  - else → an absolute short date via `toLocaleDateString` (:22-26), which
 *    never throws even for an invalid `Date` (e.g. `ts` outside the ±8.64e15
 *    valid range renders `'Invalid Date'` rather than throwing).
 *
 * This suite generalizes the hand-written boundary examples in
 * `relativeTime.test.ts` (exact `sec` values at 59/60, 3599/3600, …) into
 * three properties: totality over the whole `number` domain (never throws,
 * including NaN/±Infinity/out-of-range doubles), the zero/NaN guard pinned
 * for arbitrary partners, and rank+in-bucket monotonicity as `now - ts`
 * grows — the boundary constants are exercised indirectly by covering the
 * full integer range rather than re-asserting each cutoff by hand.
 *
 * `formatAbsoluteDateTime` (:31-40) gets a lightweight totality + zero-guard
 * check too, since it lives in the same module and shares the `!ts` guard
 * shape — cheap insurance against the same class of regression.
 */
import { describe, expect, it } from 'vitest'
import fc from 'fast-check'
import { fuzzParams, fuzzTestTimeout } from '@/test/fuzz'
import { formatAbsoluteDateTime, formatRelativeTime } from './relativeTime.ts'

const SECOND = 1000
const MINUTE = 60 * SECOND
const HOUR = 60 * MINUTE
const DAY = 24 * HOUR

// ──── generators ────

/** Special-value numbers the guard/arithmetic must survive without
 *  throwing: falsy (0/NaN), infinities, and the extremes of the safe and
 *  full double range. */
const edgeNumberArb: fc.Arbitrary<number> = fc.constantFrom(
  0, -0, 1, -1, NaN, Infinity, -Infinity,
  Number.MAX_SAFE_INTEGER, Number.MIN_SAFE_INTEGER,
  Number.MAX_VALUE, -Number.MAX_VALUE, Number.EPSILON,
)

/** Arbitrary `number` — any finite/NaN/infinite double, an arbitrary
 *  32-bit-ish integer, or a hand-picked edge value — used for the
 *  never-throws and zero-guard properties, which must hold over the whole
 *  `number` domain, not just plausible epoch timestamps. */
const anyNumberArb: fc.Arbitrary<number> = fc.oneof(
  edgeNumberArb,
  fc.double(),
  fc.integer(),
)

/** A plausible epoch-ms timestamp (~2001-05-18 to ~2033-05-18), used for the
 *  monotonicity property so bucket transitions are exercised over a
 *  realistic, always-positive, always-nonzero range rather than degenerating
 *  into edge-value guard hits. */
const plausibleNowArb: fc.Arbitrary<number> =
  fc.integer({ min: 1_000_000_000_000, max: 2_000_000_000_000 })

/** Non-negative ms offsets up to ~400 days — enough to cross every bucket
 *  boundary (minute/hour/day/absolute) at least once. */
const MAX_DELTA_MS = 400 * DAY
const sortedDeltaPairArb: fc.Arbitrary<[number, number]> = fc
  .tuple(
    fc.integer({ min: 0, max: MAX_DELTA_MS }),
    fc.integer({ min: 0, max: MAX_DELTA_MS }),
  )
  .map(([a, b]): [number, number] => (a <= b ? [a, b] : [b, a]))

// ──── bucket ranking (mirrors relativeTime.ts:17-26) ────

type Bucket = { rank: number; n: number | null }

/** Classifies a `formatRelativeTime` label into a comparable
 *  (rank, in-bucket-number) pair. Ranks follow the branch order in the
 *  source (:17-26): 'just now' < minutes < hours < days < absolute date. */
const classify = (label: string): Bucket => {
  if (label === 'just now') return { rank: 0, n: null }
  let m = /^(\d+)m ago$/.exec(label)
  if (m) return { rank: 1, n: Number(m[1]) }
  m = /^(\d+)h ago$/.exec(label)
  if (m) return { rank: 2, n: Number(m[1]) }
  m = /^(\d+)d ago$/.exec(label)
  if (m) return { rank: 3, n: Number(m[1]) }
  return { rank: 4, n: null } // absolute date fallback
}

describe('formatRelativeTime — totality', () => {
  it('never throws for arbitrary (ts, now)', () => {
    fc.assert(
      fc.property(anyNumberArb, anyNumberArb, (ts, now) => {
        expect(() => formatRelativeTime(ts, now)).not.toThrow()
      }),
      fuzzParams(500),
    )
  }, fuzzTestTimeout())
})

describe('formatRelativeTime — zero/NaN guard (relativeTime.ts:15)', () => {
  it('returns "" for a falsy ts regardless of now', () => {
    fc.assert(
      fc.property(fc.constantFrom(0, -0, NaN), anyNumberArb, (ts, now) => {
        expect(formatRelativeTime(ts, now)).toBe('')
      }),
      fuzzParams(200),
    )
  }, fuzzTestTimeout())

  it('returns "" for a falsy now regardless of ts', () => {
    fc.assert(
      fc.property(anyNumberArb, fc.constantFrom(0, -0, NaN), (ts, now) => {
        expect(formatRelativeTime(ts, now)).toBe('')
      }),
      fuzzParams(200),
    )
  }, fuzzTestTimeout())
})

describe('formatRelativeTime — bucket monotonicity as (now - ts) grows', () => {
  it('ranks non-decreasing, and the in-bucket count non-decreasing within a shared bucket', () => {
    fc.assert(
      fc.property(plausibleNowArb, sortedDeltaPairArb, (now, [d1, d2]) => {
        const ts1 = now - d1 // closer to `now` (smaller elapsed time)
        const ts2 = now - d2 // further from `now` (larger or equal elapsed time)
        fc.pre(ts1 !== 0 && ts2 !== 0)

        const b1 = classify(formatRelativeTime(ts1, now))
        const b2 = classify(formatRelativeTime(ts2, now))

        expect(b1.rank, `${ts1},${ts2},${now}`).toBeLessThanOrEqual(b2.rank)
        if (b1.rank === b2.rank && b1.n !== null && b2.n !== null) {
          expect(b1.n, `${ts1},${ts2},${now}`).toBeLessThanOrEqual(b2.n)
        }
      }),
      fuzzParams(500),
    )
  }, fuzzTestTimeout())
})

describe('formatAbsoluteDateTime — totality + zero guard (relativeTime.ts:31-40)', () => {
  it('never throws, and returns "" only for a falsy ts', () => {
    fc.assert(
      fc.property(anyNumberArb, ts => {
        expect(() => formatAbsoluteDateTime(ts)).not.toThrow()
        if (!ts) expect(formatAbsoluteDateTime(ts)).toBe('')
      }),
      fuzzParams(300),
    )
  }, fuzzTestTimeout())
})
