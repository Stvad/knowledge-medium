import { describe, expect, it } from 'vitest'
import { dailyNoteDateProp } from '../schema.ts'
import { dueBoundary, dueByDailyNoteRef } from '../dueQuery.ts'

/** How `getOrCreateDailyNote` stores a calendar day: UTC midnight of that
 *  day. Reproduced here so the assertions below compare against real stored
 *  values rather than against the boundary's own arithmetic. */
const storedDailyNoteDate = (iso: string): number => Date.parse(`${iso}T00:00:00Z`)

describe('dueBoundary', () => {
  it('is UTC midnight of the day after the local date, not local midnight', () => {
    // The whole point: west of UTC, local midnight encodes to LATER than
    // tomorrow's UTC-midnight daily note, which would pull tomorrow's items
    // into a "due today or earlier" list a day early.
    expect(dueBoundary(new Date(2026, 5, 1, 14, 30)).toISOString())
      .toBe('2026-06-02T00:00:00.000Z')
  })

  it('admits a daily note dated today and rejects tomorrow, at any hour', () => {
    for (const hour of [0, 9, 23]) {
      const boundary = dueBoundary(new Date(2026, 5, 1, hour, 30)).getTime()
      expect(storedDailyNoteDate('2026-05-31')).toBeLessThan(boundary)
      expect(storedDailyNoteDate('2026-06-01')).toBeLessThan(boundary)
      expect(storedDailyNoteDate('2026-06-02')).toBeGreaterThanOrEqual(boundary)
    }
  })
})

describe('dueByDailyNoteRef', () => {
  it('traverses the named ref into the daily note and compares its own date', () => {
    // The `target` operator is what the query compiler needs to see; comparing
    // the ref column itself would compare block ids against a date.
    const now = new Date(2026, 5, 1)
    expect(dueByDailyNoteRef('readwise:review_date', now)).toEqual({
      'readwise:review_date': {
        target: {[dailyNoteDateProp.name]: {lt: dueBoundary(now)}},
      },
    })
  })
})
