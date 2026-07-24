/** Training days and the weekly template.
 *
 *  The one non-obvious rule here is the rollover hour. Sessions run
 *  midnight–1am, so calendar dates split a single workout from the day it
 *  belongs to: Session B is "Sunday late", logged at 00:40 on Monday. Every
 *  date the engine reasons about — template lookup, gap arithmetic, "have I
 *  already trained tonight" — goes through `trainingDay` first.
 */

import type {ProgramConfig, SessionType, WorkoutRecord} from './types'
import {isFullSession} from './types'

const MS_PER_DAY = 86_400_000

const pad = (n: number): string => String(n).padStart(2, '0')

const toDate = (value: Date | string): Date =>
  value instanceof Date ? value : new Date(value)

/** Local calendar day a timestamp belongs to, shifted back by the
 *  rollover hour. Returns `YYYY-MM-DD`. */
export const trainingDay = (value: Date | string, rolloverHour: number): string => {
  const d = toDate(value)
  const shifted = new Date(d.getTime())
  shifted.setHours(shifted.getHours() - rolloverHour)
  return `${shifted.getFullYear()}-${pad(shifted.getMonth() + 1)}-${pad(shifted.getDate())}`
}

/** Local weekday (0 = Sunday) of a training day string. Parsed as local
 *  midnight so the value matches what the user sees on a calendar. */
export const weekdayOfDay = (day: string): number => {
  const [y, m, d] = day.split('-').map(Number)
  return new Date(y, m - 1, d).getDay()
}

/** Whole days between two training days. Parsed at local noon so DST
 *  shifts can't round a 7-day gap to 6. */
export const daysBetween = (from: string, to: string): number => {
  const parse = (day: string): number => {
    const [y, m, d] = day.split('-').map(Number)
    return new Date(y, m - 1, d, 12).getTime()
  }
  return Math.round((parse(to) - parse(from)) / MS_PER_DAY)
}

export const scheduledSession = (
  day: string,
  template: Readonly<Record<number, SessionType>>,
): SessionType | undefined => template[weekdayOfDay(day)]

/** Which session to prescribe. The template wins when it has an entry for
 *  today. Off-template nights (the plan's schedule slips constantly — that's
 *  the whole premise) fall back to whichever full session is more overdue,
 *  so an unplanned Wednesday session still gets a coherent prescription
 *  instead of nothing. */
export const resolveSession = (
  day: string,
  history: readonly WorkoutRecord[],
  config: ProgramConfig,
): {session: SessionType; offSchedule: boolean} => {
  const scheduled = scheduledSession(day, config.weeklyTemplate)
  if (scheduled) return {session: scheduled, offSchedule: false}

  const lastDay = (session: SessionType): string | undefined =>
    history
      .filter(w => w.session === session)
      .map(w => trainingDay(w.date, config.dayRolloverHour))
      .sort()
      .at(-1)

  const lastA = lastDay('A')
  const lastB = lastDay('B')
  if (lastA === undefined) return {session: 'A', offSchedule: true}
  if (lastB === undefined) return {session: 'B', offSchedule: true}
  return {session: lastA <= lastB ? 'A' : 'B', offSchedule: true}
}

/** Full sessions only, oldest first, keyed by training day. Mini days are
 *  excluded here on purpose — they don't reset the gap clock. */
export const fullSessionDays = (
  history: readonly WorkoutRecord[],
  rolloverHour: number,
): readonly string[] =>
  history
    .filter(w => isFullSession(w.session))
    .map(w => trainingDay(w.date, rolloverHour))
    .sort()
