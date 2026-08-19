// @vitest-environment node
/**
 * Fuzz suite for the SM-2.5 scheduling math in `../scheduler.ts`. See
 * `src/test/fuzz.ts` for smoke/deep tier mechanics and `docs/fuzzing.md`
 * for conventions.
 *
 * ──── Domain, grounded at the call sites ────
 *
 * `getNewSrsParametersFromValues` (scheduler.ts:68-98) takes an
 * `SrsParams {interval, factor}` plus a `signal` and an injected
 * `random()`, and returns `enforceLimits(addJitter(...))`.
 * `enforceLimits` (scheduler.ts:52-55) is asymmetric by construction:
 * `interval: Math.min(interval, MAX_INTERVAL)` clamps a CEILING only;
 * `factor: Math.max(factor, MIN_FACTOR)` clamps a FLOOR only. There is no
 * `MIN_INTERVAL`/`MAX_FACTOR` constant anywhere in the file.
 *
 * The type signature places no runtime restriction on `interval`/`factor`
 * beyond `number`, and neither does the actual persisted domain: both
 * ride the `'number'` value preset (schema.ts:19-35), whose codec is
 * `requireFiniteNumber` on both encode and decode (codecs.ts:100-111) —
 * finite, any sign, any magnitude, no range check. Two real, non-scheduler
 * write paths land values in that full-sign domain without any additional
 * guard: a user hand-editing the property value, and the Roam-memo
 * importer, which parses a foreign `interval::`/`eFactor::` free-text
 * field via `Number.parseFloat` + `Number.isFinite` only
 * (roamMemo.ts:60-64, consumed at :97-98, written at :140-141) — so an
 * imported `interval:: -5` deposits a legally-typed, codec-legal negative
 * interval with nothing downstream to reject it. `NaN`/`Infinity` are
 * the one thing the codec DOES reject (`Number.isFinite` check,
 * codecs.ts:101) on both read and write, so they are not reachable
 * through the real storage path and are out of scope here (probing
 * `Math.max(NaN, x) === NaN` would just restate a JS builtin, not the
 * product).
 *
 * The real caller (`planSrsRescheduleFromBasis`, index.ts:232-241) always
 * passes an explicit `now` (`basis.scheduleFrom`) but relies on the
 * `random` default (`Math.random`, scheduler.ts:119) — every property
 * below injects `random` explicitly instead, so the target never reads
 * `Math.random`/`Date.now()` and no `withPinnedRandom` pin is needed.
 *
 * ──── Properties ────
 *
 * 1. Documented bounds (scheduler.ts:52-55) hold across the FULL
 *    finite-number domain (both signs, both operands): output
 *    `factor >= MIN_FACTOR`, `interval <= MAX_INTERVAL`, and both outputs
 *    stay finite (a real requirement — the codec that will re-encode them
 *    rejects non-finite values, codecs.ts:100-105).
 * 2a. Positive control: for the domain every legitimate signal chain can
 *    actually reach starting from a positive seed — `interval >= 0`,
 *    `factor >= MIN_FACTOR` — `scheduleSrsProperties` never schedules
 *    before `now` (scheduler.ts:113-125). AGAIN resets to a fixed 1
 *    (:79); HARD/GOOD/EASY multiply by a positive factor (:83,86,89);
 *    SOONER multiplies by 0.75 (:93) — jitter is ±5% of that value
 *    (:57-66), so sign is preserved and magnitude never crosses zero.
 *    FIXED (was a fuzz find of this suite): `addDays` used LOCAL
 *    `getDate()`/`setDate()` calendar math, so in a "fall back" DST hour
 *    `addDays(now, 0)` landed up to 1h BEFORE `now` (deep-tier seed
 *    1261623029; only reproduced under a DST-observing local timezone —
 *    a UTC-pinned runner never saw it). addDays now keeps calendar math
 *    (consumers collapse to a local DATE, and day-length-ms arithmetic
 *    shifts that date across DST boundaries) but clamps the result to
 *    `>= date`, so this property holds in every timezone. This FILE pins
 *    `process.env.TZ` to a DST-observing zone below — on a UTC CI runner
 *    the pre-fix bug was invisible, so without the pin this regression
 *    pin was decorative (adversarial review on PR #384).
 * 2b. FIXED (was a fuzz find of this suite, red at the smoke seed): a
 *    NEGATIVE starting interval — codec-legal, concretely reachable via
 *    the Roam-memo importer's unchecked parseFloat — survived every
 *    signal except AGAIN and produced `nextReviewDate < now`.
 *    `enforceLimits` floors the interval at 0 alongside its MAX_INTERVAL
 *    cap, and `rebuildBase` rescues the multiplication base so 0 is not
 *    an absorbing state; the property below pins the fix.
 * 3. Determinism: identical `(params, signal, now, random)` produce
 *    identical output — no hidden nondeterminism beyond the injected
 *    clock/PRNG.
 */
import { afterAll, describe, expect, it } from 'vitest'
import fc from 'fast-check'
import { fuzzParams, fuzzTestTimeout } from '@/test/fuzz'
import {
  getNewSrsParametersFromValues,
  scheduleSrsProperties,
  srsSignals,
  SrsSignal,
} from '../scheduler.ts'

// DST-observing zone pin (see docblock §2a): the addDays monotonicity
// property is vacuous under UTC — GitHub runners never cross a DST
// transition, so the pre-fix bug ran green there. Set before any Date is
// constructed in this module (nowArb below); Node re-reads TZ per
// localtime conversion on Linux/macOS. Restored in afterAll because
// vitest reuses worker processes across test FILES — leaking the zone
// into whatever file runs next in this worker is a flake vector.
const originalTz = process.env.TZ
process.env.TZ = 'America/New_York'
afterAll(() => {
  if (originalTz === undefined) delete process.env.TZ
  else process.env.TZ = originalTz
})

// Not exported from scheduler.ts; mirrored here with a line citation.
// scheduler.test.ts's pinned examples ("caps the interval at the 50-year
// ceiling", "clamps the ease factor to the 1.3 floor…") already guard
// against either constant silently drifting without this file noticing.
const MIN_FACTOR = 1.3 // scheduler.ts:34
const MAX_INTERVAL = 50 * 365 // scheduler.ts:33

/** The real persisted domain for interval/factor (see docblock): any
 *  finite number, any sign, any magnitude — bounded here only to keep
 *  arithmetic comfortably inside double range for the finiteness checks. */
const finiteNumberArb = (min: number, max: number): fc.Arbitrary<number> =>
  fc.double({min, max, noNaN: true, noDefaultInfinity: true})

/** Well-behaved injected `random()`: a single value per case, matching
 *  `Math.random`'s [0, 1) contract (the implicit convention
 *  `randomFromInterval`, scheduler.ts:46-50, assumes). */
const randomValueArb = fc.double({min: 0, max: 0.999999, noNaN: true, noDefaultInfinity: true})

const nowArb = fc.date({min: new Date(2000, 0, 1), max: new Date(2100, 0, 1), noInvalidDate: true})

describe('getNewSrsParametersFromValues — documented bounds (scheduler.ts:52-55)', () => {
  it('factor never drops below MIN_FACTOR, interval never exceeds MAX_INTERVAL, both stay finite — across the full finite-number input domain', () => {
    fc.assert(
      fc.property(
        finiteNumberArb(-1e9, 1e9),
        finiteNumberArb(-1e9, 1e9),
        fc.constantFrom(...srsSignals),
        randomValueArb,
        (interval, factor, signal, randomValue) => {
          const out = getNewSrsParametersFromValues({interval, factor}, signal, () => randomValue)
          expect(Number.isFinite(out.factor)).toBe(true)
          expect(Number.isFinite(out.interval)).toBe(true)
          expect(out.factor).toBeGreaterThanOrEqual(MIN_FACTOR)
          expect(out.interval).toBeLessThanOrEqual(MAX_INTERVAL)
        },
      ),
      fuzzParams(300),
    )
  })
})

describe('scheduleSrsProperties — nextReviewDate ordering (scheduler.ts:113-125)', () => {
  it('never schedules earlier than `now` starting from a non-negative interval (the range every real signal transition reaches from a positive seed)', () => {
    fc.assert(
      fc.property(
        finiteNumberArb(0, 1e6),
        finiteNumberArb(MIN_FACTOR, 50),
        fc.constantFrom(...srsSignals),
        randomValueArb,
        nowArb,
        (interval, factor, signal, randomValue, now) => {
          const {nextReviewDate} = scheduleSrsProperties(
            {interval, factor},
            signal,
            {now, random: () => randomValue},
          )
          expect(nextReviewDate.getTime()).toBeGreaterThanOrEqual(now.getTime())
        },
      ),
      fuzzParams(300),
    )
  }, fuzzTestTimeout())

  // Regression pin for a fuzz find of this suite: `enforceLimits` used to
  // clamp the interval CEILING only. A negative interval is codec-legal
  // (codecs.ts:100-111, no sign/range check) and reachable in practice via
  // the Roam-memo importer (roamMemo.ts:60-64/97-98/140-141, which only
  // checks `Number.isFinite` on a foreign `interval::` field); it survived
  // every signal except AGAIN (the only branch that discards the prior
  // interval outright) and produced a `nextReviewDate` before `now`. The
  // interval floor in `enforceLimits` heals it to "due now".
  it('a negative starting interval is healed by the enforceLimits floor — never schedules BEFORE `now`', () => {
    fc.assert(
      fc.property(
        finiteNumberArb(-1e6, -0.01),
        finiteNumberArb(MIN_FACTOR, 50),
        fc.constantFrom(SrsSignal.HARD, SrsSignal.GOOD, SrsSignal.EASY, SrsSignal.SOONER),
        randomValueArb,
        nowArb,
        (interval, factor, signal, randomValue, now) => {
          const {nextReviewDate} = scheduleSrsProperties(
            {interval, factor},
            signal,
            {now, random: () => randomValue},
          )
          expect(nextReviewDate.getTime()).toBeGreaterThanOrEqual(now.getTime())
        },
      ),
      fuzzParams(50),
    )
  }, fuzzTestTimeout())
})

describe('scheduleSrsProperties — determinism', () => {
  it('is a pure function of (params, signal, now, random): identical inputs produce identical output', () => {
    fc.assert(
      fc.property(
        finiteNumberArb(-1e6, 1e6),
        finiteNumberArb(-1e6, 1e6),
        fc.constantFrom(...srsSignals),
        randomValueArb,
        nowArb,
        (interval, factor, signal, randomValue, now) => {
          const random = () => randomValue
          const a = scheduleSrsProperties({interval, factor}, signal, {now, random})
          const b = scheduleSrsProperties({interval, factor}, signal, {now, random})
          expect(a.interval).toBe(b.interval)
          expect(a.factor).toBe(b.factor)
          expect(a.nextReviewDate.getTime()).toBe(b.nextReviewDate.getTime())
        },
      ),
      fuzzParams(300),
    )
  })
})
