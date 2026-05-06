import { formatRoamDate } from '@/utils/dailyPage'

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

const DAILY_NOTE_PAGE_SOURCE =
  '(January|February|March|April|May|June|July|August|September|October|November|December) [0-3]?[0-9](st|nd|rd|th), [0-9][0-9][0-9][0-9]'
const ROAM_DATE_REFERENCE_RE = new RegExp(`\\[\\[${DAILY_NOTE_PAGE_SOURCE}]]`, 'gm')

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

const inlinePropertyMatcher = (name: string): RegExp =>
  new RegExp(`(?:\\[\\[|{)\\[\\[${name}]]::?(.*?)(?:]]|})`, 'g')

const getInlineProperty = (text: string, name: string): string | undefined =>
  inlinePropertyMatcher(name).exec(text)?.[1]

const createInlineProperty = (name: string, value: string): string =>
  `[[[[${name}]]:${value}]]`

const withInlineProperty = (
  text: string,
  name: string,
  value: string,
): string => {
  const property = createInlineProperty(name, value)
  return getInlineProperty(text, name)
    ? text.replace(inlinePropertyMatcher(name), property)
    : `${text} ${property}`
}

const getNumberProperty = (text: string, name: string): number | undefined => {
  const value = getInlineProperty(text, name)
  return value === undefined ? undefined : parseFloat(value)
}

const withInterval = (text: string, interval: number): string =>
  withInlineProperty(text, 'interval', Number(interval).toFixed(1))

const withFactor = (text: string, factor: number): string =>
  withInlineProperty(text, 'factor', Number(factor).toFixed(2))

const listDatePages = (text: string): string[] =>
  text.match(ROAM_DATE_REFERENCE_RE) || []

const toDatePage = (date: Date): string =>
  `[[${formatRoamDate(date)}]]`

const withDate = (text: string, date: Date): string => {
  const currentDates = listDatePages(text)
  const newDate = toDatePage(date)
  return currentDates.length === 1
    ? text.replace(currentDates[0], newDate)
    : `${text} ${newDate}`
}

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

export const getNewSrsParameters = (
  text: string,
  signal: SrsSignal,
  random: () => number = Math.random,
): SrsParams => {
  const factor = getNumberProperty(text, 'factor') || DEFAULT_FACTOR
  const interval = getNumberProperty(text, 'interval') || DEFAULT_INTERVAL

  return getNewSrsParametersFromValues({interval, factor}, signal, random)
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

export const scheduleSrsContent = (
  text: string,
  signal: SrsSignal,
  options: SrsScheduleOptions = {},
): string => {
  const now = options.now ?? new Date()
  const random = options.random ?? Math.random
  const params = getNewSrsParameters(text, signal, random)

  return `${withDate(
    withFactor(
      withInterval(text, params.interval),
      params.factor,
    ),
    addDays(now, Math.ceil(params.interval)),
  )} *`
}
