export enum SrsSignal {
  AGAIN = 1,
  HARD,
  GOOD,
  EASY,
  SOONER,
}

export const srsSignals = [
  SrsSignal.AGAIN,
  SrsSignal.HARD,
  SrsSignal.GOOD,
  SrsSignal.EASY,
  SrsSignal.SOONER,
] as const

export interface SrsScheduleOptions {
  now?: Date
  random?: () => number
}

export interface SrsParams {
  interval: number
  factor: number
}

export interface ScheduledSrsParams extends SrsParams {
  nextReviewDate: Date
}

export const DEFAULT_FACTOR = 2.5
export const DEFAULT_INTERVAL = 2
const MAX_INTERVAL = 50 * 365
const MIN_FACTOR = 1.3
const HARD_FACTOR = 1.3
const SOONER_FACTOR = 0.75
const JITTER_PERCENTAGE = 0.05
const FACTOR_MODIFIER = 0.15

// Local setDate() calendar math with a monotonicity clamp. Two contracts
// pull in different directions here:
//   - the review queue relies on addDays(now, n>=0) >= now (a "fall
//     back" DST hour can make raw setDate math land BEFORE `now`, so a
//     zero-interval reschedule was due in the past — found by
//     scheduler.fuzz.test.ts);
//   - every consumer collapses the result to a local calendar DATE
//     (formatIsoDate → nextReviewIso → daily-note bucketing), and the
//     scrub path anchors at local midnight — so pure day-length-ms
//     arithmetic crossing a DST boundary shifts the stored date a whole
//     day (midnight + k·86400000ms lands at 23:00 the previous day).
// Calendar math keeps the DATE right; the max() clamp keeps monotonicity.
const addDays = (date: Date, days: number): Date => {
  const next = new Date(date)
  next.setDate(next.getDate() + days)
  return new Date(Math.max(next.getTime(), date.getTime()))
}

const randomFromInterval = (
  min: number,
  max: number,
  random: () => number,
): number => random() * (max - min) + min

// Interval is floored at 0 as well as capped: the stored value rides the
// plain finite-number codec (any sign), and a corrupted/imported negative
// interval survives every signal except AGAIN — multiplying through to a
// nextReviewDate in the PAST (found by scheduler.fuzz.test.ts; concretely
// reachable via the Roam-memo importer's unchecked parseFloat). Mostly a
// belt now: `rebuildBase` rescues non-positive inputs before the
// multiplicative arms, so post-rescue outputs are already positive.
const enforceLimits = ({interval, factor}: SrsParams): SrsParams => ({
  interval: Math.min(Math.max(interval, 0), MAX_INTERVAL),
  factor: Math.max(factor, MIN_FACTOR),
})

// A non-positive stored interval (corrupted/imported data) is an
// ABSORBING state under every multiplicative arm — 0×factor = 0, so
// HARD/GOOD/EASY/SOONER never rebuild it and the card stays perpetually
// due while the buttons advertise real intervals (adversarial review on
// PR #384). Rescue the multiplication BASE to 1 day for those inputs
// only; legitimate small positives (e.g. SOONER's 0.75 of a 1-day card)
// pass through untouched.
const rebuildBase = (interval: number): number => (interval > 0 ? interval : 1)

const addJitter = (
  {interval, factor}: SrsParams,
  random: () => number,
): SrsParams => {
  const jitter = interval * JITTER_PERCENTAGE
  return {
    interval: interval + randomFromInterval(-jitter, jitter, random),
    factor,
  }
}

export const getNewSrsParametersFromValues = (
  {interval, factor}: SrsParams,
  signal: SrsSignal,
  random: () => number = Math.random,
): SrsParams => {
  let newFactor = factor
  let newInterval = interval
  const base = rebuildBase(interval)

  switch (signal) {
    case SrsSignal.AGAIN:
      newFactor = factor - 0.2
      newInterval = 1
      break
    case SrsSignal.HARD:
      newFactor = factor - FACTOR_MODIFIER
      newInterval = base * HARD_FACTOR
      break
    case SrsSignal.GOOD:
      newInterval = base * factor
      break
    case SrsSignal.EASY:
      newInterval = base * factor
      newFactor = factor + FACTOR_MODIFIER
      break
    case SrsSignal.SOONER:
      newInterval = base * SOONER_FACTOR
      break
  }

  return enforceLimits(addJitter({interval: newInterval, factor: newFactor}, random))
}

/** Projected next interval (in days, un-rounded) for `signal` given the
 *  card's current params, computed with the jitter neutralised
 *  (`random() = 0.5` is the midpoint of the ±jitter range, so it cancels)
 *  so the value is stable enough to show as a pre-grade estimate on the
 *  review buttons. The committed reschedule re-applies real jitter, so the
 *  card can land ±`JITTER_PERCENTAGE` off this — fine for an estimate.
 *  Feed the result through the same `formatIntervalDays` the toast uses so
 *  the button label and the post-grade toast agree. */
export const estimateSrsIntervalDays = (
  params: SrsParams,
  signal: SrsSignal,
): number => getNewSrsParametersFromValues(params, signal, () => 0.5).interval

export const scheduleSrsProperties = (
  params: SrsParams,
  signal: SrsSignal,
  options: SrsScheduleOptions = {},
): ScheduledSrsParams => {
  const now = options.now ?? new Date()
  const random = options.random ?? Math.random
  const next = getNewSrsParametersFromValues(params, signal, random)
  return {
    ...next,
    nextReviewDate: addDays(now, Math.ceil(next.interval)),
  }
}
