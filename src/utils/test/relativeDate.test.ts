import { describe, it, expect } from 'vitest'
import { parseRelativeDate } from '@/utils/relativeDate'

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
})
