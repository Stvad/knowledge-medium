/**
 * Calendar primitives shared between `DailyNotePicker` (header
 * navigation) and `ReschedulePicker` (mobile reschedule sheet). Both
 * used to keep private copies of these helpers; centralising them
 * here lets the two callers share `CalendarGrid` without dragging
 * the rest of either component into a common module.
 *
 * Locale: weekday labels and `formatDayLabel` are en-US to match the
 * existing pickers — generalising to user locale is a separate task
 * (the whole codebase still hard-codes 'en-US' in a few date
 * formatters).
 */
import { formatIsoDate } from '@/utils/dailyPage.js'

export interface CalendarCell {
  date: Date | null
  iso: string | null
}

/** 6 weeks × 7 days — fixed grid so consumers can rely on a stable
 *  cell count regardless of month length / start-of-week. */
export const CALENDAR_CELL_COUNT = 42

export const CALENDAR_WEEKDAY_LABELS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'] as const

export const monthLabel = (date: Date): string =>
  date.toLocaleString('en-US', {month: 'long'})

export const firstOfMonth = (date: Date): Date =>
  new Date(date.getFullYear(), date.getMonth(), 1)

export const addMonths = (date: Date, months: number): Date =>
  new Date(date.getFullYear(), date.getMonth() + months, 1)

/** Parse an ISO date string into a local-midnight Date, or null if
 *  the string isn't a valid `YYYY-MM-DD`. The round-trip check
 *  guards against inputs like `2026-02-30` that JS Date silently
 *  rewrites. */
export const fromIso = (iso: string): Date | null => {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso)
  if (!match) return null
  const date = new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]))
  if (Number.isNaN(date.getTime())) return null
  return formatIsoDate(date) === iso ? date : null
}

/** Resolve a Date to seed the calendar's "visible month" state from
 *  an optional ISO string. Falls back to "now" if absent or invalid. */
export const initialDateFromIso = (iso: string | undefined): Date => {
  if (!iso) return new Date()
  return fromIso(iso) ?? new Date()
}

/** Build the 42-cell month grid, with leading/trailing empty cells
 *  for out-of-month positions. Week starts Monday (matches
 *  `CALENDAR_WEEKDAY_LABELS`). */
export const buildCalendarCells = (visibleMonth: Date): CalendarCell[] => {
  const year = visibleMonth.getFullYear()
  const month = visibleMonth.getMonth()
  const leadingEmptyCells = (new Date(year, month, 1).getDay() + 6) % 7
  const daysInMonth = new Date(year, month + 1, 0).getDate()

  return Array.from({length: CALENDAR_CELL_COUNT}, (_, index) => {
    const day = index - leadingEmptyCells + 1
    if (day < 1 || day > daysInMonth) return {date: null, iso: null}
    const date = new Date(year, month, day)
    return {date, iso: formatIsoDate(date)}
  })
}

/** ARIA-label-friendly day name, e.g. "March 21, 2026". */
export const formatDayLabel = (date: Date): string =>
  date.toLocaleDateString('en-US', {
    day: 'numeric',
    month: 'long',
    year: 'numeric',
  })
