// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createUserActivity } from '../userActivity'

const QUIET = 10_000

beforeEach(() => { vi.useFakeTimers() })
afterEach(() => { vi.useRealTimers() })

/** Whether `promise` has settled, without waiting for it. */
const settled = async (promise: Promise<unknown>): Promise<boolean> => {
  let done = false
  void promise.then(() => { done = true })
  await vi.advanceTimersByTimeAsync(0)
  return done
}

describe('createUserActivity', () => {
  it('is quiet before any input arrives', async () => {
    const activity = createUserActivity(new EventTarget())

    expect(await settled(activity.whenQuiet(QUIET))).toBe(true)
  })

  it.each(['keydown', 'pointerdown', 'wheel', 'scroll', 'input'])(
    'holds a waiter for the quiet window after a %s',
    async type => {
      const target = new EventTarget()
      const activity = createUserActivity(target)
      target.dispatchEvent(new Event(type))

      const quiet = activity.whenQuiet(QUIET)
      await vi.advanceTimersByTimeAsync(QUIET - 1)
      expect(await settled(quiet)).toBe(false)
      await vi.advanceTimersByTimeAsync(1)
      expect(await settled(quiet)).toBe(true)
    },
  )

  it('restarts the window on input that arrives while a waiter is held', async () => {
    const target = new EventTarget()
    const activity = createUserActivity(target)
    target.dispatchEvent(new Event('keydown'))
    const quiet = activity.whenQuiet(QUIET)

    await vi.advanceTimersByTimeAsync(QUIET / 2)
    target.dispatchEvent(new Event('keydown'))
    await vi.advanceTimersByTimeAsync(QUIET / 2)
    expect(await settled(quiet)).toBe(false)

    await vi.advanceTimersByTimeAsync(QUIET / 2)
    expect(await settled(quiet)).toBe(true)
  })

  it('ignores events that are not input', async () => {
    const target = new EventTarget()
    const activity = createUserActivity(target)
    target.dispatchEvent(new Event('focus'))

    expect(await settled(activity.whenQuiet(QUIET))).toBe(true)
  })
})
