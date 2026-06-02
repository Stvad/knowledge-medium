import { describe, expect, it } from 'vitest'
import { dueBoundary } from '../dueQuery.ts'

// The query *shape* used to be asserted here (e.g. `expect(q.exclude)
// .toEqual(...)`), but those tests just re-stated the builder and gave
// false confidence — they passed while the compiled query returned zero
// due cards. Behavior is now covered end-to-end against a real DB in
// `dueCards.integration.test.ts`. Only `dueBoundary` keeps a unit test:
// it's a non-trivial date computation, not a re-statement of code.
describe('dueBoundary', () => {
  it('is UTC midnight of the day after the local date (matching daily-note storage)', () => {
    // Daily notes store `daily-note:date` at UTC midnight, so the cutoff
    // must be UTC midnight of tomorrow's local date — not local
    // midnight, which west of UTC would include tomorrow's cards.
    const boundary = dueBoundary(new Date(2026, 5, 1, 14, 30))
    expect(boundary.toISOString()).toBe('2026-06-02T00:00:00.000Z')
  })
})
