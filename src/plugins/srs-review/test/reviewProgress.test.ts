import { describe, expect, it } from 'vitest'
import { reconcileRestoredQueue, restoreSavedSession } from '../reviewProgress.ts'
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

describe('reconcileRestoredQueue', () => {
  const due = (...ids: string[]) => new Set(ids)

  it('drops not-yet-reached cards that are no longer due', () => {
    // At index 2, c/d/e are upcoming; d was rescheduled away (not due).
    expect(reconcileRestoredQueue(['a', 'b', 'c', 'd', 'e'], 2, due('c', 'e')))
      .toEqual(['a', 'b', 'c', 'e'])
  })

  it('keeps already-reviewed cards even though they are no longer due', () => {
    // a/b were graded this session (now future-dated, absent from the due
    // set) but precede the index — kept so Back/re-grade still works.
    expect(reconcileRestoredQueue(['a', 'b', 'c'], 2, due('c')))
      .toEqual(['a', 'b', 'c'])
  })

  it('returns the same reference when nothing is dropped', () => {
    const queue = ['a', 'b', 'c']
    expect(reconcileRestoredQueue(queue, 1, due('b', 'c'))).toBe(queue)
  })

  it('can empty the upcoming portion when nothing ahead is due', () => {
    expect(reconcileRestoredQueue(['a', 'b', 'c'], 1, due('x'))).toEqual(['a'])
  })
})
