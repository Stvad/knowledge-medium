import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createSettleScheduler } from '../settleScheduler.ts'

beforeEach(() => { vi.useFakeTimers() })
afterEach(() => { vi.useRealTimers() })

describe('createSettleScheduler', () => {
  it('runs once after the delay', () => {
    const run = vi.fn()
    const scheduler = createSettleScheduler(run)

    scheduler.schedule(150)
    vi.advanceTimersByTime(149)
    expect(run).not.toHaveBeenCalled()
    vi.advanceTimersByTime(1)
    expect(run).toHaveBeenCalledTimes(1)
  })

  it('replaces a pending run rather than stacking', () => {
    const run = vi.fn()
    const scheduler = createSettleScheduler(run)

    scheduler.schedule(150)
    vi.advanceTimersByTime(100)
    scheduler.schedule(150)
    vi.advanceTimersByTime(149)
    expect(run).not.toHaveBeenCalled()
    vi.advanceTimersByTime(1)
    expect(run).toHaveBeenCalledTimes(1)
  })

  // The whole reason this exists. Running directly used to leave the armed
  // timeout behind, free to fire inside the NEXT quiet period — moving the
  // cursor while the user was still scrolling, with no cleanup able to reach it.
  it('cancels the pending run when it is run directly', () => {
    const run = vi.fn()
    const scheduler = createSettleScheduler(run)

    scheduler.schedule(150)
    vi.advanceTimersByTime(50)
    scheduler.runNow()
    expect(run).toHaveBeenCalledTimes(1)

    // Past where the orphan would have fired.
    vi.advanceTimersByTime(200)
    expect(run).toHaveBeenCalledTimes(1)
  })

  // ...and the orphan must not survive into a later schedule either, which is
  // the shape that actually bit: exit edit mode mid-debounce, then keep
  // scrolling.
  it('leaves nothing behind that could fire inside a later quiet period', () => {
    const run = vi.fn()
    const scheduler = createSettleScheduler(run)

    scheduler.schedule(150)
    vi.advanceTimersByTime(50)
    scheduler.runNow()
    scheduler.schedule(150)

    vi.advanceTimersByTime(149)
    expect(run).toHaveBeenCalledTimes(1)
    vi.advanceTimersByTime(1)
    expect(run).toHaveBeenCalledTimes(2)
  })

  it('cancels a pending run', () => {
    const run = vi.fn()
    const scheduler = createSettleScheduler(run)

    scheduler.schedule(150)
    scheduler.cancel()
    vi.advanceTimersByTime(500)
    expect(run).not.toHaveBeenCalled()
  })
})
