// @vitest-environment node
import { describe, expect, it, vi } from 'vitest'
import type { SyncDrainStats } from '@/data/internals/syncObserver/observer'
import type { DownloadTimings } from '@/data/internals/initialDownload.js'
import { startSyncMetricsCollector } from '../collect'
import { DRAIN_RECORD_MIN_ROWS } from '../record'
import { scheduleIdle } from '@/utils/scheduleIdle.js'

const stats = (over: Partial<SyncDrainStats>): SyncDrainStats => ({
  source: 'queue', completed: true, endedAtMs: 1000, wallMs: 10, windows: 1, rows: 5,
  applied: 5, deferred: 0, skippedStale: 0, quarantined: 0, deleted: 0,
  readMs: 1, decodeMs: 1, writeMs: 1, invalidateMs: 1, bookkeepingMs: 1, deferredIndexRows: 0, deferredIndexMs: 0, ...over,
})

const timings: DownloadTimings = { startedAtMs: 1, totalMs: 100 }

type DrainCb = (s: SyncDrainStats) => void

const fakeRepo = () => {
  let drain: DrainCb | undefined
  let finishDrain!: () => void
  const drained = new Promise<void>((resolve) => { finishDrain = resolve })
  const repo = {
    db: {},
    onSyncDrainStats: (cb: DrainCb) => { drain = cb; return () => { drain = undefined } },
    flushSyncObserver: () => drained,
  }
  return { repo: repo as never, drain: (s: SyncDrainStats) => drain!(s), finishDrain, hasDrainListener: () => drain !== undefined }
}

/** A turn queued after the one under test: anything unheld would have run by now. */
const idleTurn = () => new Promise<void>((resolve) => { scheduleIdle(() => resolve()) })

describe('startSyncMetricsCollector', () => {
  it('persists a qualifying drain as a drain record', async () => {
    const write = vi.fn(async () => 'id')
    const f = fakeRepo()
    startSyncMetricsCollector(f.repo, 'ws', { write, takeDownload: () => null })

    f.drain(stats({ rows: DRAIN_RECORD_MIN_ROWS }))
    await vi.waitFor(() => expect(write).toHaveBeenCalledTimes(1))
    const [, workspaceId, data] = write.mock.calls[0] as unknown as [unknown, string, Record<string, unknown>]
    expect(workspaceId).toBe('ws')
    expect(data).toMatchObject({ kind: 'drain', rows: DRAIN_RECORD_MIN_ROWS, endedAtMs: 1000 })
  })

  it('ignores a small drain', async () => {
    const write = vi.fn(async () => 'id')
    const f = fakeRepo()
    startSyncMetricsCollector(f.repo, 'ws', { write, takeDownload: () => null })
    f.drain(stats({ rows: 10 }))
    await idleTurn()
    expect(write).not.toHaveBeenCalled()
  })

  it('does not throw into the listener when the write rejects', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      const write = vi.fn(async () => { throw new Error('boom') })
      const f = fakeRepo()
      startSyncMetricsCollector(f.repo, 'ws', { write, takeDownload: () => null })
      expect(() => f.drain(stats({ rows: 5000 }))).not.toThrow()
      await vi.waitFor(() => expect(warn).toHaveBeenCalled())
    } finally {
      warn.mockRestore()
    }
  })

  it('writes the download record only once the drain has caught up', async () => {
    const write = vi.fn(async () => 'id')
    const f = fakeRepo()
    startSyncMetricsCollector(f.repo, 'ws', { write, takeDownload: () => Promise.resolve(timings) })
    // Held until the drain has materialized what the download delivered.
    await idleTurn()
    expect(write).not.toHaveBeenCalled()
    f.finishDrain()
    await vi.waitFor(() => expect(write).toHaveBeenCalledTimes(1))
    expect((write.mock.calls[0] as unknown as unknown[])[2]).toMatchObject({ kind: 'download' })
  })

  it('writes no download record when none was tracked', async () => {
    const write = vi.fn(async () => 'id')
    const f = fakeRepo()
    startSyncMetricsCollector(f.repo, 'ws', { write, takeDownload: () => null })
    f.finishDrain()
    await idleTurn()
    expect(write).not.toHaveBeenCalled()
  })

  it('writes no download record when stopped before the timings resolve', async () => {
    const write = vi.fn(async () => 'id')
    const f = fakeRepo()
    let resolveTimings!: (t: DownloadTimings) => void
    const download = new Promise<DownloadTimings>((resolve) => { resolveTimings = resolve })
    const stop = startSyncMetricsCollector(f.repo, 'ws', { write, takeDownload: () => download })
    stop()
    resolveTimings(timings)
    f.finishDrain()
    await download
    await idleTurn()
    await idleTurn()
    expect(write).not.toHaveBeenCalled()
    expect(f.hasDrainListener()).toBe(false)
  })
})
