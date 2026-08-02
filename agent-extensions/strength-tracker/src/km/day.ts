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

const isUtcMidnight = (value: Date): boolean =>
  value.getUTCHours() === 0 && value.getUTCMinutes() === 0
  && value.getUTCSeconds() === 0 && value.getUTCMilliseconds() === 0

/** Could `dayToDate` have written this? Local noon exactly, which is the only
 *  thing it produces. */
const isOurLocalNoon = (value: Date): boolean =>
  value.getHours() === 12 && value.getMinutes() === 0
  && value.getSeconds() === 0 && value.getMilliseconds() === 0

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
 *  meant; anything else is a real instant, and its LOCAL parts do.
 *
 *  Except that local noon IS UTC midnight at two offsets, not one. At UTC+12
 *  both readings give the same day and nothing is at stake. At UTC-12 they
 *  differ by a day, and the loser is OUR OWN encoding: `dayToDate('2026-08-01')`
 *  serialises to `2026-08-02T00:00:00.000Z`, which the UTC reading calls the
 *  2nd. Every session stamped there was filed a day forward — including past
 *  `standingSession`, so Start could not find the session it had just made.
 *
 *  So the date-only reading is refused for anything `dayToDate` could have
 *  written. At every offset but ±12 that check is inert (our writes are not UTC
 *  midnight, the editor's are not local noon), and at ±12 it keeps our own
 *  writes correct.
 *
 *  The cost, stated rather than glossed: at exactly UTC-12 the two encodings
 *  are the same instant, so no predicate over one `Date` can separate them, and
 *  an editor-typed date there now reads a day early — the bug this function
 *  exists to fix, surviving in the one place it cannot be fixed. That trade is
 *  deliberate: our writes are every session, the editor's are the occasional
 *  hand-repair, and UTC-12 (Baker and Howland Islands) has no permanent
 *  population to hit either way. */
export const storedDate = (value: Date): Date =>
  isUtcMidnight(value) && !isOurLocalNoon(value)
    ? new Date(value.getUTCFullYear(), value.getUTCMonth(), value.getUTCDate(), 12, 0, 0, 0)
    : value

export const dateToDay = (date: Date): string =>
  `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
