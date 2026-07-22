import { describe, expect, it } from 'vitest'
import { formatRelativeTime } from './relativeTime.ts'

const SECOND = 1000
const MINUTE = 60 * SECOND
const HOUR = 60 * MINUTE
const DAY = 24 * HOUR

describe('formatRelativeTime', () => {
  const now = Date.UTC(2026, 6, 22, 12, 0, 0)

  it('returns empty string for a missing/zero timestamp', () => {
    expect(formatRelativeTime(0, now)).toBe('')
  })

  it('collapses sub-minute and future (clock-skew) timestamps to "just now"', () => {
    expect(formatRelativeTime(now - 5 * SECOND, now)).toBe('just now')
    expect(formatRelativeTime(now + 3 * SECOND, now)).toBe('just now')
  })

  it('reports minutes, hours, and days under a week', () => {
    expect(formatRelativeTime(now - 5 * MINUTE, now)).toBe('5m ago')
    expect(formatRelativeTime(now - 3 * HOUR, now)).toBe('3h ago')
    expect(formatRelativeTime(now - 2 * DAY, now)).toBe('2d ago')
    expect(formatRelativeTime(now - 6 * DAY, now)).toBe('6d ago')
  })

  it('falls back to an absolute date once past a week', () => {
    const label = formatRelativeTime(now - 30 * DAY, now)
    expect(label).not.toMatch(/ago$/)
    expect(label).toMatch(/2026/)
  })
})
