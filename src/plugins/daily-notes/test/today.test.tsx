// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, render } from '@testing-library/react'

import { useStartOfToday, useTodayKey } from '../today.ts'

const Probe = ({onRender}: {onRender: (key: string) => void}) => {
  const key = useTodayKey()
  onRender(key)
  return <span>{key}</span>
}

const StampProbe = () => <span>{useStartOfToday()}</span>

/** Advance wall-clock time far enough that the poller's next tick observes a
 *  new local calendar date. */
const rollOverToNextDay = async (from: Date) => {
  const nextDay = new Date(from)
  nextDay.setDate(nextDay.getDate() + 1)
  nextDay.setHours(0, 1, 0, 0)
  vi.setSystemTime(nextDay)
  await act(async () => { await vi.advanceTimersByTimeAsync(60_000) })
}

const START = new Date(2026, 5, 1, 23, 30)

beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(START)
})
afterEach(() => {
  cleanup()
  vi.useRealTimers()
})

describe('today store', () => {
  it('runs ONE rollover poller no matter how many consumers are mounted', () => {
    // The reason this module exists: the old shape was a `setInterval` per
    // component, so every date-sensitive surface added another timer.
    const setInterval = vi.spyOn(globalThis, 'setInterval')

    render(<><StampProbe/><StampProbe/><StampProbe/></>)

    expect(setInterval).toHaveBeenCalledTimes(1)
  })

  it('runs no poller once the last consumer unmounts', () => {
    const clearInterval = vi.spyOn(globalThis, 'clearInterval')
    const {unmount} = render(<><StampProbe/><StampProbe/></>)

    unmount()

    expect(clearInterval).toHaveBeenCalledTimes(1)
    // ...and a later tick can't notify anyone into a re-render.
    expect(vi.getTimerCount()).toBe(0)
  })

  it('advances consumers when the local date rolls over', async () => {
    const renders: string[] = []
    render(<Probe onRender={key => renders.push(key)}/>)
    expect(renders.at(-1)).toBe('2026-6-1')

    await rollOverToNextDay(START)

    expect(renders.at(-1)).toBe('2026-6-2')
  })

  it('does not re-render consumers on a tick within the same day', async () => {
    const renders: string[] = []
    render(<Probe onRender={key => renders.push(key)}/>)
    const before = renders.length

    vi.setSystemTime(new Date(2026, 5, 1, 23, 45))
    await act(async () => { await vi.advanceTimersByTimeAsync(60_000) })

    expect(renders.length).toBe(before)
  })

  it('re-reads the date when a consumer subscribes after an idle rollover', async () => {
    // With nothing mounted the poller is stopped, so the cached value goes
    // stale. A fresh consumer must not inherit yesterday.
    const {unmount} = render(<StampProbe/>)
    unmount()

    const nextDay = new Date(START)
    nextDay.setDate(nextDay.getDate() + 1)
    vi.setSystemTime(nextDay)

    const renders: string[] = []
    render(<Probe onRender={key => renders.push(key)}/>)

    expect(renders.at(-1)).toBe('2026-6-2')
  })
})
