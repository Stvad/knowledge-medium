import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { observation, stubPerformanceObserver, type FakeObservation } from '@/test/fakePerformanceObserver'
import {
  getLastLongTaskEndMs,
  getStartupTimeline,
  hasStartupMark,
  longTasksSupported,
  markStartup,
  onLongTask,
  resetStartupTimeline,
  startStartupObservers,
} from '../startupTimeline.js'

describe('startupTimeline', () => {
  beforeEach(() => resetStartupTimeline())
  afterEach(() => vi.restoreAllMocks())

  it('records the first timestamp per phase and ignores later marks (boot happens once)', () => {
    vi.spyOn(performance, 'now').mockReturnValueOnce(100).mockReturnValueOnce(250)
    markStartup('repoReady')
    markStartup('repoReady') // re-render / StrictMode re-invoke — must not overwrite
    expect(getStartupTimeline().marks.repoReady).toBe(100)
  })

  it('captures phases independently and reports which are absent', () => {
    vi.spyOn(performance, 'now').mockReturnValueOnce(10).mockReturnValueOnce(20)
    markStartup('repoReady')
    markStartup('interactive')
    const { marks } = getStartupTimeline()
    expect(marks.repoReady).toBe(10)
    expect(marks.interactive).toBe(20)
    expect(marks.bootstrapDone).toBeUndefined()
    expect(hasStartupMark('bootstrapDone')).toBe(false)
  })

  it('reset clears all marks', () => {
    markStartup('repoReady')
    resetStartupTimeline()
    expect(getStartupTimeline().marks).toEqual({})
  })
})

// The long-task tracking feeds the startup-metrics interactive (TTI) detector,
// which debounces a quiet window off these events. Drive it with a fake
// PerformanceObserver (node's real one doesn't support the 'longtask' type).
describe('startupTimeline long-task tracking', () => {
  let deliver: FakeObservation['deliver']

  beforeEach(() => {
    resetStartupTimeline()
    const live = stubPerformanceObserver(['longtask'])
    startStartupObservers()
    deliver = observation(live, 'longtask').deliver
  })
  afterEach(() => {
    resetStartupTimeline()
    vi.unstubAllGlobals()
  })

  it('tracks the latest long-task end and notifies subscribers only when it advances', () => {
    expect(longTasksSupported()).toBe(true)
    const fired: number[] = []
    onLongTask(() => fired.push(getLastLongTaskEndMs() ?? -1))

    deliver([{ startTime: 100, duration: 300 }]) // end 400
    expect(getLastLongTaskEndMs()).toBe(400)
    expect(fired).toEqual([400])

    deliver([{ startTime: 50, duration: 100 }]) // end 150 — does NOT advance the max
    expect(getLastLongTaskEndMs()).toBe(400)
    expect(fired).toEqual([400]) // no spurious notification

    deliver([{ startTime: 600, duration: 200 }]) // end 800 — advances
    expect(getLastLongTaskEndMs()).toBe(800)
    expect(fired).toEqual([400, 800])
  })

  it('a throwing subscriber does not break peers or the observer', () => {
    const fired: string[] = []
    onLongTask(() => { throw new Error('boom') })
    onLongTask(() => fired.push('ok'))
    expect(() => deliver([{ startTime: 0, duration: 60 }])).not.toThrow()
    expect(fired).toEqual(['ok'])
  })
})
