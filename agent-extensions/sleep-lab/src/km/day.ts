/** Wake-date ↔ Date conversion for the stored `date` properties.
 *
 *  A wake date is a `YYYY-MM-DD` string; the block stores it as a Date at
 *  local noon. Noon is deliberate: it's the furthest point from a midnight or
 *  DST boundary, so the day survives the round-trip through the date codec's
 *  UTC ISO string and back to local calendar parts.
 *
 *  Same rule as the Strength Tracker's `day.ts`, for the same two shapes:
 *  this extension writes local noon, while the app's date property editor
 *  writes `new Date('YYYY-MM-DD')` — UTC MIDNIGHT — whose LOCAL calendar day
 *  is the day before anywhere west of UTC. `storedDate` reads each by the
 *  parts that name the day meant.
 */

const pad = (n: number): string => String(n).padStart(2, '0')

export const dayToDate = (day: string): Date => {
  const [y, m, d] = day.split('-').map(Number)
  return new Date(y, m - 1, d, 12, 0, 0, 0)
}

const isUtcMidnight = (value: Date): boolean =>
  value.getUTCHours() === 0 && value.getUTCMinutes() === 0
  && value.getUTCSeconds() === 0 && value.getUTCMilliseconds() === 0

/** Could `dayToDate` have written this? Local noon exactly. */
const isOurLocalNoon = (value: Date): boolean =>
  value.getHours() === 12 && value.getMinutes() === 0
  && value.getSeconds() === 0 && value.getMilliseconds() === 0

/** A stored date property as the local-noon Date this extension means by it.
 *
 *  A UTC-midnight timestamp is a date-ONLY value (the editor's), so its UTC
 *  parts name the day; anything else is a real instant and its LOCAL parts
 *  do. The date-only reading is refused for anything `dayToDate` could have
 *  written, which only matters at UTC±12 where local noon IS UTC midnight —
 *  and there it keeps our own writes correct at the cost of an editor-typed
 *  date reading a day early. Accepted: our writes are every night, the
 *  editor's are the occasional hand-repair. */
export const storedDate = (value: Date): Date =>
  isUtcMidnight(value) && !isOurLocalNoon(value)
    ? new Date(value.getUTCFullYear(), value.getUTCMonth(), value.getUTCDate(), 12, 0, 0, 0)
    : value

export const dateToDay = (date: Date): string =>
  `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`

/** `day` plus `n` calendar days, in local time. */
export const addDays = (day: string, n: number): string => {
  const date = dayToDate(day)
  date.setDate(date.getDate() + n)
  return dateToDay(date)
}
