// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { createDownloadTracker } from '../downloadTracker'

const progress = (downloadedOperations: number, totalOperations: number) => ({
  totalOperations, downloadedOperations, downloadedFraction: downloadedOperations / totalOperations,
})

const setup = () => {
  let t = 0
  const tracker = createDownloadTracker({ now: () => t, epoch: () => 1_000_000 + t })
  return { tracker, at: (ms: number) => { t = ms } }
}

describe('createDownloadTracker', () => {
  it('splits a fresh download into download and apply time', () => {
    const { tracker, at } = setup()
    at(100); expect(tracker.sample({ hasSynced: false, downloadProgress: progress(0, 400) })).toBeNull()
    at(2000); expect(tracker.sample({ hasSynced: false, downloadProgress: progress(400, 400) })).toBeNull()
    at(2500)
    expect(tracker.sample({ hasSynced: true, downloadProgress: null })).toEqual({
      startedAtMs: 1_000_000, downloadMs: 2000, applyMs: 500, totalMs: 2500,
      totalOperations: 400, operationsAtStart: 0,
    })
  })

  it('reports operationsAtStart > 0 for a download resumed after a reload', () => {
    const { tracker, at } = setup()
    at(10); tracker.sample({ downloadProgress: progress(300, 400) })
    at(20); tracker.sample({ downloadProgress: progress(400, 400) })
    at(30)
    expect(tracker.sample({ hasSynced: true })).toMatchObject({ operationsAtStart: 300, totalOperations: 400 })
  })

  it('omits download and apply time when hasSynced arrives without fraction 1 ever seen', () => {
    const { tracker, at } = setup()
    at(10); tracker.sample({ downloadProgress: progress(50, 400) })
    at(900)
    const out = tracker.sample({ hasSynced: true })
    expect(out).toMatchObject({ totalMs: 900, totalOperations: 400 })
    expect(out?.downloadMs).toBeUndefined()
    expect(out?.applyMs).toBeUndefined()
  })

  it('omits operation counts when no progress was ever observed', () => {
    const { tracker, at } = setup()
    at(5)
    const out = tracker.sample({ hasSynced: true })
    expect(out?.totalOperations).toBeUndefined()
    expect(out?.operationsAtStart).toBeUndefined()
  })

  it('keeps the first instant fraction 1 was reached and the max total', () => {
    const { tracker, at } = setup()
    at(10); tracker.sample({ downloadProgress: progress(100, 100) })
    at(50); tracker.sample({ downloadProgress: progress(100, 150) })
    at(70)
    expect(tracker.sample({ hasSynced: true })).toMatchObject({ downloadMs: 10, applyMs: 60, totalOperations: 150 })
  })
})
