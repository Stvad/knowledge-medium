import { beforeEach, describe, expect, it, vi } from 'vitest'

// Capture the deep-idle callbacks so the test drives when a scheduled pass actually fires,
// deterministically (no real idle/timer timing).
const idleQueue: Array<() => void> = []
vi.mock('@/utils/scheduleIdle.js', () => ({
  CATCHUP_DEEP_IDLE: {},
  scheduleDeepIdle: (fn: () => void) => {
    idleQueue.push(fn)
  },
}))

import { coalescedDeepIdlePass } from './laneSchedule.js'

const drainIdle = async () => {
  const pending = idleQueue.splice(0)
  for (const fn of pending) fn()
  await Promise.resolve() // let the fire-and-forget `work()` settle
}

beforeEach(() => {
  idleQueue.length = 0
})

describe('coalescedDeepIdlePass', () => {
  it('runs work on the idle window, not synchronously on schedule', async () => {
    const work = vi.fn(async () => {})
    const { schedulePass } = coalescedDeepIdlePass(work, 'label')

    schedulePass()
    expect(work).not.toHaveBeenCalled() // deferred, not inline on the hot path
    await drainIdle()
    expect(work).toHaveBeenCalledTimes(1)
  })

  it('coalesces overlapping arms before the idle window into ONE pass', async () => {
    const work = vi.fn(async () => {})
    const { schedulePass } = coalescedDeepIdlePass(work, 'label')

    schedulePass()
    schedulePass()
    schedulePass()
    expect(idleQueue).toHaveLength(1) // three arms → one queued pass
    await drainIdle()
    expect(work).toHaveBeenCalledTimes(1)
  })

  it('re-arms after a pass fires (the scheduled guard resets)', async () => {
    const work = vi.fn(async () => {})
    const { schedulePass } = coalescedDeepIdlePass(work, 'label')

    schedulePass()
    await drainIdle()
    schedulePass()
    await drainIdle()
    expect(work).toHaveBeenCalledTimes(2)
  })

  it('does not run a pass already queued once cancel() has been called', async () => {
    const work = vi.fn(async () => {})
    const { schedulePass, cancel } = coalescedDeepIdlePass(work, 'label')

    schedulePass() // queued
    cancel() // effect torn down before the idle window fires
    await drainIdle()
    expect(work).not.toHaveBeenCalled()
  })

  it('swallows a rejected work (log-only) instead of throwing out of the idle callback', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const { schedulePass } = coalescedDeepIdlePass(async () => {
      throw new Error('boom')
    }, '[test] pass failed')

    schedulePass()
    await drainIdle()
    expect(warn).toHaveBeenCalledWith('[test] pass failed', expect.any(Error))
    warn.mockRestore()
  })
})
