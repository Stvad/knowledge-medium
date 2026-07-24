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

export const dateToDay = (date: Date): string =>
  `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
