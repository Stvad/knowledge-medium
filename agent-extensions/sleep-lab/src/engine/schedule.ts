/** The experiment schedule: pairs of periods, order randomized within each
 *  pair. See PROTOCOL.md §3.
 *
 *  Dates throughout are wake-date strings (`YYYY-MM-DD`); `../km/day.ts`
 *  owns the local-calendar arithmetic so this stays consistent with how the
 *  night blocks read their own `date` property.
 */

import {addDays, dayToDate} from '../km/day'
import {mulberry32} from './prng'
import type {Arm, Period, ScheduleSpec} from './types'

const MS_PER_DAY = 86_400_000

/** Whole days between two wake dates. Parsed at local noon (via
 *  `dayToDate`) so a DST boundary can't round a day off. */
const daysBetween = (from: string, to: string): number =>
  Math.round((dayToDate(to).getTime() - dayToDate(from).getTime()) / MS_PER_DAY)

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/

export const buildSchedule = (spec: ScheduleSpec): Period[] => {
  const {startDate, periodNights, pairs, seed} = spec
  if (!DATE_RE.test(startDate)) {
    throw new Error(`buildSchedule: startDate must be YYYY-MM-DD, got ${JSON.stringify(startDate)}`)
  }
  if (!Number.isInteger(periodNights) || periodNights < 1) {
    throw new Error(`buildSchedule: periodNights must be a positive integer, got ${periodNights}`)
  }
  if (!Number.isInteger(pairs) || pairs < 1) {
    throw new Error(`buildSchedule: pairs must be a positive integer, got ${pairs}`)
  }

  const rng = mulberry32(seed)
  const periods: Period[] = []
  let cursor = startDate
  for (let pair = 1; pair <= pairs; pair++) {
    // One coin flip per pair, drawn before either period is built, so the
    // sequence of draws (and hence the schedule) depends only on the seed
    // and the pair count — never on periodNights or prior period lengths.
    const arms: [Arm, Arm] = rng() < 0.5 ? ['intervention', 'control'] : ['control', 'intervention']
    for (const arm of arms) {
      const from = cursor
      const to = addDays(from, periodNights - 1)
      periods.push({index: periods.length + 1, pair, arm, from, to})
      cursor = addDays(to, 1)
    }
  }
  return periods
}

// Generic over the element type (not just `Period`) so a caller holding
// `(Period & {id: string})[]` — every period read back off a block — gets
// its `id` back too, instead of losing it to a bare `Period` return type.
export const periodForDate = <P extends Period>(periods: readonly P[], date: string): P | undefined =>
  periods.find(p => p.from <= date && date <= p.to)

export const armForDate = (periods: readonly Period[], date: string): Arm | undefined =>
  periodForDate(periods, date)?.arm

export const isTransitionNight = (period: Period, date: string): boolean => date === period.from

export const scheduleEnd = (periods: readonly Period[]): string | undefined =>
  periods.length === 0 ? undefined : periods.map(p => p.to).sort().at(-1)

export const scheduleProgress = (
  periods: readonly Period[],
  today: string,
): {night: number; total: number} | undefined => {
  if (periods.length === 0) return undefined
  const start = periods[0].from
  const end = scheduleEnd(periods)
  if (end === undefined || today < start || today > end) return undefined
  return {night: daysBetween(start, today) + 1, total: daysBetween(start, end) + 1}
}
