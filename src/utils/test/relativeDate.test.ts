import { describe, it, expect } from 'vitest'
import {
  parseLiteralDailyPageTitle,
  parseRelativeDate,
  relativeDateCandidates,
} from '@/utils/relativeDate'

// 2026-04-28 (Tuesday) — anchor date for tests, matches the user's
// "now" in the working session so test failures correlate with what
// the user sees.
const NOW = new Date(2026, 3, 28, 10, 30)

describe('parseRelativeDate', () => {
  it('returns null for empty input', () => {
    expect(parseRelativeDate('', NOW)).toBeNull()
    expect(parseRelativeDate('   ', NOW)).toBeNull()
  })

  it('returns null for non-date input', () => {
    expect(parseRelativeDate('Foobar', NOW)).toBeNull()
    expect(parseRelativeDate('asdf qwer', NOW)).toBeNull()
  })

  it('returns null when only a fragment of the input is a date', () => {
    // Substring matches must not hijack arbitrary aliases.
    expect(parseRelativeDate('Project Friday', NOW)).toBeNull()
    expect(parseRelativeDate('Foobar 28', NOW)).toBeNull()
  })

  it('parses "today" to the anchor date', () => {
    const result = parseRelativeDate('today', NOW)
    expect(result?.iso).toBe('2026-04-28')
  })

  it('parses "tomorrow" forward one day', () => {
    expect(parseRelativeDate('tomorrow', NOW)?.iso).toBe('2026-04-29')
  })

  it('parses "yesterday" back one day', () => {
    expect(parseRelativeDate('yesterday', NOW)?.iso).toBe('2026-04-27')
  })

  it('parses bare weekday as the next forward occurrence', () => {
    // Tuesday is anchor — Friday is 3 days ahead.
    expect(parseRelativeDate('Friday', NOW)?.iso).toBe('2026-05-01')
    // Past weekday rolls forward, never backward.
    expect(parseRelativeDate('Monday', NOW)?.iso).toBe('2026-05-04')
  })

  it('parses three-letter weekday abbreviations', () => {
    // Backlink autocomplete fires while the user is mid-typing, so we
    // need partial words to resolve too — typing "fri" inside [[…]] must
    // suggest Friday, not nothing.
    expect(parseRelativeDate('fri', NOW)?.iso).toBe('2026-05-01')
    expect(parseRelativeDate('mon', NOW)?.iso).toBe('2026-05-04')
  })

  it('parses month + day forward when the date is past', () => {
    // April 1 is past; forwardDate pushes to next year.
    expect(parseRelativeDate('April 1', NOW)?.iso).toBe('2027-04-01')
  })

  it('parses month + day for a future date in current year', () => {
    expect(parseRelativeDate('May 5', NOW)?.iso).toBe('2026-05-05')
  })

  it('parses "next week" to the anchor of that week', () => {
    // chrono resolves "next week" to the start of the upcoming week.
    const result = parseRelativeDate('next week', NOW)
    expect(result).not.toBeNull()
    // Whichever day chrono picks for "next week", it must be in the
    // future — that's the only behavior we depend on downstream.
    expect(result!.date.getTime()).toBeGreaterThan(NOW.getTime())
  })

  it('parses an explicit ISO date', () => {
    expect(parseRelativeDate('2026-12-25', NOW)?.iso).toBe('2026-12-25')
  })

  it('rejects implausible years (chrono will eat a 5-digit-year typo)', () => {
    // Real Roam-import bug: a page titled "20201-04-01" (typo for
    // 2021-04-01) crashed the importer because chrono parsed the year
    // as 20201, then formatIsoDate emitted "20201-04-01" and the daily-
    // note regex rejected the 5-digit year. Better to treat the whole
    // string as a non-date and import as a regular page.
    expect(parseRelativeDate('20201-04-01', NOW)).toBeNull()
    expect(parseRelativeDate('999-04-01', NOW)).toBeNull()
  })
})

describe('relativeDateCandidates', () => {
  it('returns today and tomorrow for the shared "to" prefix', () => {
    expect(relativeDateCandidates('to', NOW).map(candidate => ({
      phrase: candidate.phrase,
      iso: candidate.iso,
    }))).toEqual([
      {phrase: 'today', iso: '2026-04-28'},
      {phrase: 'tomorrow', iso: '2026-04-29'},
    ])
  })

  it('narrows today/tomorrow prefixes as the query becomes less ambiguous', () => {
    expect(relativeDateCandidates('tod', NOW).map(candidate => candidate.phrase)).toEqual(['today'])
    expect(relativeDateCandidates('tom', NOW).map(candidate => candidate.phrase)).toEqual(['tomorrow'])
  })

  it('falls back to full relative-date parsing for complete date phrases', () => {
    expect(relativeDateCandidates('fri', NOW).map(candidate => ({
      phrase: candidate.phrase,
      iso: candidate.iso,
    }))).toEqual([{phrase: 'fri', iso: '2026-05-01'}])
  })

  it('deduplicates prefix candidates and parsed candidates', () => {
    expect(relativeDateCandidates('today', NOW).map(candidate => ({
      phrase: candidate.phrase,
      iso: candidate.iso,
    }))).toEqual([{phrase: 'today', iso: '2026-04-28'}])
  })

  it('does not treat one-letter prefixes or non-dates as date candidates', () => {
    expect(relativeDateCandidates('t', NOW)).toEqual([])
    expect(relativeDateCandidates('topic', NOW)).toEqual([])
  })
})

describe('parseLiteralDailyPageTitle', () => {
  it.each([
    ['0001-01-02', 'January 2nd, 1'],
    ['0900-03-01', 'March 1st, 900'],
  ])('reads both canonical aliases of %s in the same year', (iso, long) => {
    for (const alias of [iso, long]) {
      const parsed = parseLiteralDailyPageTitle(alias)
      expect(parsed?.iso).toBe(iso)
      expect(parsed?.date.getFullYear()).toBe(Number(iso.slice(0, 4)))
    }
  })

  it('accepts ISO dates', () => {
    expect(parseLiteralDailyPageTitle('2026-04-28')?.iso).toBe('2026-04-28')
    expect(parseLiteralDailyPageTitle('2026-12-25')?.iso).toBe('2026-12-25')
  })

  it('accepts Roam-style long-form dates', () => {
    expect(parseLiteralDailyPageTitle('April 28th, 2026')?.iso).toBe('2026-04-28')
    expect(parseLiteralDailyPageTitle('April 1st, 2026')?.iso).toBe('2026-04-01')
    expect(parseLiteralDailyPageTitle('December 22nd, 2026')?.iso).toBe('2026-12-22')
    expect(parseLiteralDailyPageTitle('March 3rd, 2026')?.iso).toBe('2026-03-03')
  })

  it('rejects relative-time keywords that chrono.casual would accept', () => {
    // The whole point of this helper: at storage time we must NOT
    // collapse `[[today]]` / `[[now]]` / `[[friday]]` / `[[may]]` into
    // a calendar id. Otherwise re-importing a Roam graph stuffs
    // *every* historical block that mentioned a relative-time word
    // into the *current* day's backlinks (the bug this guard exists
    // to prevent).
    expect(parseLiteralDailyPageTitle('today')).toBeNull()
    expect(parseLiteralDailyPageTitle('now')).toBeNull()
    expect(parseLiteralDailyPageTitle('tomorrow')).toBeNull()
    expect(parseLiteralDailyPageTitle('yesterday')).toBeNull()
    expect(parseLiteralDailyPageTitle('friday')).toBeNull()
    expect(parseLiteralDailyPageTitle('Monday')).toBeNull()
    expect(parseLiteralDailyPageTitle('may')).toBeNull()
    expect(parseLiteralDailyPageTitle('April')).toBeNull()
    expect(parseLiteralDailyPageTitle('noon')).toBeNull()
    expect(parseLiteralDailyPageTitle('tonight')).toBeNull()
    expect(parseLiteralDailyPageTitle('evening')).toBeNull()
    expect(parseLiteralDailyPageTitle('next week')).toBeNull()
    expect(parseLiteralDailyPageTitle('3 days ago')).toBeNull()
  })

  it('rejects month + day without year (not a daily-page title)', () => {
    // "April 28" is a regular Roam page, not a daily — the daily for
    // that day is titled "April 28th, 2026".
    expect(parseLiteralDailyPageTitle('April 28')).toBeNull()
    expect(parseLiteralDailyPageTitle('May 5')).toBeNull()
  })

  it('rejects malformed-but-coercible date literals', () => {
    // chrono is happy to reinterpret these; we are not.
    expect(parseLiteralDailyPageTitle('2026-13-01')).toBeNull()
    expect(parseLiteralDailyPageTitle('April 31st, 2026')).toBeNull()
  })

  it('rejects non-date strings', () => {
    expect(parseLiteralDailyPageTitle('Foobar')).toBeNull()
    expect(parseLiteralDailyPageTitle('Project Friday')).toBeNull()
    expect(parseLiteralDailyPageTitle('')).toBeNull()
  })
})
