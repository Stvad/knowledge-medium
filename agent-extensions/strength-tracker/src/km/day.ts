/** Training-day ↔ Date conversion for the stored `date` properties.
 *
 *  A training day is a `YYYY-MM-DD` string; the block stores it as a Date at
 *  local noon. Noon is deliberate: it's the furthest point from a midnight or
 *  DST boundary, so the day survives the round-trip through the date codec's
 *  UTC ISO string and back to local calendar parts.
 */

const pad = (n: number): string => String(n).padStart(2, '0')

export const dayToDate = (day: string): Date => {
  const [y, m, d] = day.split('-').map(Number)
  return new Date(y, m - 1, d, 12, 0, 0, 0)
}

/** A stored date property as the local-noon Date this extension means by it.
 *
 *  TWO shapes reach `strength:date` and the layoff dates. This extension writes
 *  local noon (`dayToDate`). The app's own date property editor writes
 *  `new Date('YYYY-MM-DD')` — which JS parses as UTC MIDNIGHT — so anywhere
 *  west of UTC that instant's LOCAL calendar day is the day before the one
 *  typed, and every reader here took it as such: repairing a session's date to
 *  2026-08-01 in America/Los_Angeles filed it on 2026-07-31, moving it to
 *  another training day for history, layoff gaps and the standing-session check
 *  alike.
 *
 *  A UTC-midnight timestamp is a date-ONLY value, so its UTC parts name the day
 *  meant; anything else is a real instant, and its LOCAL parts do. Local noon
 *  is itself UTC midnight at exactly UTC+12, where both readings give the same
 *  day — so the rule stays single-valued and this stays idempotent. */
export const storedDate = (value: Date): Date =>
  value.getUTCHours() === 0 && value.getUTCMinutes() === 0
    && value.getUTCSeconds() === 0 && value.getUTCMilliseconds() === 0
    ? new Date(value.getUTCFullYear(), value.getUTCMonth(), value.getUTCDate(), 12, 0, 0, 0)
    : value

export const dateToDay = (date: Date): string =>
  `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
