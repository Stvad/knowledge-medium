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

const addDays = (date: Date, days: number): Date => {
  const next = new Date(date)
  next.setDate(date.getDate() + days)
  return next
}

const randomFromInterval = (
  min: number,
  max: number,
  random: () => number,
): number => random() * (max - min) + min

const enforceLimits = ({interval, factor}: SrsParams): SrsParams => ({
  interval: Math.min(interval, MAX_INTERVAL),
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
