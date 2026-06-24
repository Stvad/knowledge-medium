import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  getStartupTimeline,
  hasStartupMark,
  markStartup,
  resetStartupTimeline,
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
