import { describe, expect, it } from 'vitest'
import { restoreSavedSession } from '../reviewProgress.ts'
import type { ReviewProgress } from '../schema.ts'

const progress = (over: Partial<ReviewProgress> = {}): ReviewProgress => ({
  queue: ['a', 'b', 'c'],
  index: 1,
  revealed: true,
  tag: 'math',
  day: '2026-6-2',
  ...over,
})

describe('restoreSavedSession', () => {
  it('resumes a session saved for the same tag and day', () => {
    expect(restoreSavedSession(progress(), 'math', '2026-6-2')).toEqual({
      queue: ['a', 'b', 'c'],
      index: 1,
      revealed: true,
    })
  })

  it('discards a session saved under a different tag', () => {
    expect(restoreSavedSession(progress(), 'history', '2026-6-2')).toBeNull()
  })

  it('discards a session saved on a different day (midnight rollover)', () => {
    expect(restoreSavedSession(progress(), 'math', '2026-6-3')).toBeNull()
  })

  it('ignores empty or absent saves', () => {
    expect(restoreSavedSession(null, 'math', '2026-6-2')).toBeNull()
    expect(restoreSavedSession(progress({queue: []}), 'math', '2026-6-2')).toBeNull()
  })

  it('clamps a completed save to the completion screen rather than out of bounds', () => {
    // index === queue.length is the "review complete" state; it must survive
    // restore so the user resumes on the summary, not past the end.
    expect(restoreSavedSession(progress({index: 9}), 'math', '2026-6-2')).toEqual({
      queue: ['a', 'b', 'c'],
      index: 3,
      revealed: true,
    })
  })
})
