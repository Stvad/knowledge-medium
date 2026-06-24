import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { scheduleDeepIdle } from '../scheduleIdle.js'

type IdleCb = (deadline: { didTimeout: boolean; timeRemaining: () => number }) => void

// Only `scheduleDeepIdle`'s browser path carries real logic worth testing (the
// wall-clock floor, genuine-idle gating, and fallback force-run). We exercise it
// by faking `requestIdleCallback` so the test, not the browser, decides when an
// idle window arrives. `scheduleIdle` and the no-rIC fallback are thin
// `setTimeout` wrappers and aren't re-asserted here.
describe('scheduleDeepIdle (browser path)', () => {
  let ricCalls: Array<{ cb: IdleCb; opts?: { timeout: number } }>
  let originalRic: unknown

  const idle = (timeRemaining: number) => ({ didTimeout: false, timeRemaining: () => timeRemaining })
  const timedOut = { didTimeout: true, timeRemaining: () => 0 }
  const glob = globalThis as Record<string, unknown>

  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date(2026, 0, 1))
    ricCalls = []
    originalRic = glob.requestIdleCallback
    glob.requestIdleCallback = (cb: IdleCb, opts?: { timeout: number }) => {
      ricCalls.push({ cb, opts })
      return ricCalls.length
    }
  })
  afterEach(() => {
    glob.requestIdleCallback = originalRic
    vi.useRealTimers()
  })

  it('waits out the floor before watching for idle, then runs on a genuine window', () => {
    const fn = vi.fn()
    scheduleDeepIdle(fn, { minDelayMs: 60_000 })

    vi.advanceTimersByTime(59_999)
    expect(ricCalls).toHaveLength(0) // floor not elapsed → not even watching yet

    vi.advanceTimersByTime(1)
    expect(ricCalls).toHaveLength(1)
    expect(ricCalls[0].opts).toBeUndefined() // no fallback → no force-timeout
    expect(fn).not.toHaveBeenCalled()

    ricCalls[0].cb(idle(50))
    expect(fn).toHaveBeenCalledTimes(1)
  })

  it('without a fallback, a too-brief lull re-waits instead of running', () => {
    const fn = vi.fn()
    scheduleDeepIdle(fn, { minDelayMs: 1_000, minIdleBudgetMs: 5 })
    vi.advanceTimersByTime(1_000)

    ricCalls[0].cb(idle(2)) // below budget → not a genuine idle window
    expect(fn).not.toHaveBeenCalled()
    expect(ricCalls).toHaveLength(2) // re-requested

    ricCalls[1].cb(idle(20)) // real idle now
    expect(fn).toHaveBeenCalledTimes(1)
  })

  it('with a fallback, force-runs when the browser hits the deadline even if never idle', () => {
    const fn = vi.fn()
    scheduleDeepIdle(fn, { minDelayMs: 1_000, fallbackMs: 30_000 })
    vi.advanceTimersByTime(1_000)

    // Force-timeout is the remaining time to the absolute deadline (30s − 1s floor).
    expect(ricCalls[0].opts?.timeout).toBe(29_000)
    ricCalls[0].cb(timedOut)
    expect(fn).toHaveBeenCalledTimes(1)
  })

  it('a re-waited window keeps the absolute fallback deadline (no drift past fallbackMs)', () => {
    const fn = vi.fn()
    scheduleDeepIdle(fn, { minDelayMs: 1_000, fallbackMs: 30_000, minIdleBudgetMs: 5 })
    vi.advanceTimersByTime(1_000)
    expect(ricCalls[0].opts?.timeout).toBe(29_000)

    vi.advanceTimersByTime(4_000) // 5s elapsed total
    ricCalls[0].cb(idle(1)) // brief lull → re-wait
    expect(ricCalls[1].opts?.timeout).toBe(25_000) // 30s − 5s, not a fresh 29s
  })

  it('falls back to a macrotask defer when requestIdleCallback is unavailable', () => {
    glob.requestIdleCallback = undefined
    const fn = vi.fn()
    scheduleDeepIdle(fn, { minDelayMs: 60_000 })

    expect(fn).not.toHaveBeenCalled()
    vi.runAllTimers()
    expect(fn).toHaveBeenCalledTimes(1)
  })
})
