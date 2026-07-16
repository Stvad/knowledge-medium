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

// Pure day-length ms arithmetic, NOT local setDate() calendar math: in a
// local "fall back" DST hour, setDate-based addDays(now, 0) lands up to an
// hour BEFORE `now`, so a zero-interval reschedule could be due in the
// past (found by scheduler.fuzz.test.ts). The wall-clock time of the
// result drifting ±1h across a DST boundary is immaterial next to the
// ±5% interval jitter; monotonicity (addDays(now, n>=0) >= now) is the
// contract the review queue relies on.
const DAY_MS = 86_400_000
const addDays = (date: Date, days: number): Date =>
  new Date(date.getTime() + days * DAY_MS)

const randomFromInterval = (
  min: number,
  max: number,
  random: () => number,
): number => random() * (max - min) + min

// Interval is floored at 0 as well as capped: the stored value rides the
// plain finite-number codec (any sign), and a corrupted/imported negative
// interval survives every signal except AGAIN — multiplying through to a
// nextReviewDate in the PAST (found by scheduler.fuzz.test.ts; concretely
// reachable via the Roam-memo importer's unchecked parseFloat). A floored
// 0 means "due now" until a real grade rebuilds the interval.
const enforceLimits = ({interval, factor}: SrsParams): SrsParams => ({
  interval: Math.min(Math.max(interval, 0), MAX_INTERVAL),
  factor: Math.max(factor, MIN_FACTOR),
})

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

  switch (signal) {
    case SrsSignal.AGAIN:
      newFactor = factor - 0.2
      newInterval = 1
      break
    case SrsSignal.HARD:
      newFactor = factor - FACTOR_MODIFIER
      newInterval = interval * HARD_FACTOR
      break
    case SrsSignal.GOOD:
      newInterval = interval * factor
      break
    case SrsSignal.EASY:
      newInterval = interval * factor
      newFactor = factor + FACTOR_MODIFIER
      break
    case SrsSignal.SOONER:
      newInterval = interval * SOONER_FACTOR
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
