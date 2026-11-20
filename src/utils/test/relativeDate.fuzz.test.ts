// @vitest-environment node
/**
 * Fuzz suite for `parseLiteralDailyPageTitle` (src/utils/relativeDate.ts) —
 * the storage-time decision of whether a page title IS a daily page (Roam
 * import rewires `[[…]]` aliases to a daily-note id on it). See
 * `src/test/fuzz.ts` for the tiers and `docs/fuzzing.md` for conventions.
 *
 * Contract: a title is a literal daily-page title iff it is exactly one of the
 * two canonical aliases of a real calendar day in a 4-digit year — ISO
 * `2026-04-28` or Roam long form `April 28th, 2026` — and the result names
 * that day. A miss splits a daily page in two on import; a false hit pulls
 * unrelated references into a day's backlinks.
 *
 * The oracle is built here from integers (its own leap-year rule, month
 * names and ordinal suffixes), never from `formatIsoDate` / `formatRoamDate`,
 * so a formatter bug fails the round trip instead of being agreed with.
 */
import { describe, expect, it } from 'vitest'
import fc from 'fast-check'
import { fuzzParams, fuzzTestTimeout } from '@/test/fuzz'
import { parseLiteralDailyPageTitle } from '@/utils/relativeDate'

const MONTHS = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
]

const isLeap = (year: number): boolean => (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0
const daysIn = (year: number, month: number): number =>
  [31, isLeap(year) ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][month - 1]

const ordinal = (day: number): string => {
  const lastTwo = day % 100
  if (lastTwo >= 11 && lastTwo <= 13) return `${day}th`
  return `${day}${({1: 'st', 2: 'nd', 3: 'rd'} as Record<number, string>)[day % 10] ?? 'th'}`
}

const pad = (n: number, width: number): string => String(n).padStart(width, '0')
const isoOf = (y: number, m: number, d: number): string => `${pad(y, 4)}-${pad(m, 2)}-${pad(d, 2)}`
const roamOf = (y: number, m: number, d: number): string => `${MONTHS[m - 1]} ${ordinal(d)}, ${y}`

/** Weighted toward the years notes are actually written in, but spanning the
 *  whole accepted range so its edges are explored. */
const yearArb = fc.oneof(
  {weight: 3, arbitrary: fc.integer({min: 1990, max: 2040})},
  {weight: 1, arbitrary: fc.integer({min: 1000, max: 9999})},
)

const validDayArb = fc.tuple(yearArb, fc.integer({min: 1, max: 12}))
  .chain(([y, m]) => fc.tuple(fc.constant(y), fc.constant(m), fc.integer({min: 1, max: daysIn(y, m)})))

/** A day past the end of its month (Feb 29 of a common year, April 31, …). */
const overflowDayArb = fc.tuple(yearArb, fc.integer({min: 1, max: 12}))
  .filter(([y, m]) => daysIn(y, m) < 31)
  .chain(([y, m]) => fc.tuple(fc.constant(y), fc.constant(m), fc.integer({min: daysIn(y, m) + 1, max: 31})))

const NOW = new Date(2026, 3, 28, 10, 30)

describe('parseLiteralDailyPageTitle', () => {
  it('accepts both canonical aliases of every real day and names that day', () => {
    fc.assert(
      fc.property(validDayArb, fc.boolean(), ([y, m, d], roam) => {
        const title = roam ? roamOf(y, m, d) : isoOf(y, m, d)
        const parsed = parseLiteralDailyPageTitle(title, NOW)
        expect(parsed?.iso).toBe(isoOf(y, m, d))
        expect([parsed!.date.getFullYear(), parsed!.date.getMonth() + 1, parsed!.date.getDate()]).toEqual([y, m, d])
      }),
      fuzzParams(300),
    )
  }, fuzzTestTimeout())

  it('rejects a day past the end of its month in either form', () => {
    fc.assert(
      fc.property(overflowDayArb, fc.boolean(), ([y, m, d], roam) => {
        expect(parseLiteralDailyPageTitle(roam ? roamOf(y, m, d) : isoOf(y, m, d), NOW)).toBeNull()
      }),
      fuzzParams(200),
    )
  }, fuzzTestTimeout())

  it('accepts a title only when it is exactly a canonical alias of the day it names', () => {
    // Near-misses of a real alias: a wrong ordinal, a dropped comma, a
    // case change, an unpadded ISO part, an extra word.
    const nearMissArb = fc.tuple(validDayArb, fc.nat()).map(([[y, m, d], pick]) => {
      const variants = [
        `${MONTHS[m - 1]} ${d}, ${y}`,
        `${MONTHS[m - 1]} ${ordinal(d)} ${y}`,
        `${MONTHS[m - 1].toLowerCase()} ${ordinal(d)}, ${y}`,
        `${y}-${m}-${d}`,
        `${MONTHS[m - 1]} ${ordinal(d)}`,
        `${isoOf(y, m, d)} notes`,
        `on ${roamOf(y, m, d)}`,
        `${MONTHS[m - 1].slice(0, 3)} ${ordinal(d)}, ${y}`,
      ]
      return variants[pick % variants.length]
    })
    fc.assert(
      fc.property(fc.oneof(nearMissArb, fc.string({maxLength: 24})), title => {
        const parsed = parseLiteralDailyPageTitle(title, NOW)
        if (!parsed) return
        const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(parsed.iso)
        expect(match, `iso ${parsed.iso}`).not.toBeNull()
        const [y, m, d] = match!.slice(1).map(Number)
        expect([isoOf(y, m, d), roamOf(y, m, d)]).toContain(title.trim())
      }),
      fuzzParams(300),
    )
  }, fuzzTestTimeout())
})
