// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { SyncDrainStats } from '@/data/internals/syncObserver/observer'
import { startSyncMetricsCollector } from '../collect'
import { scheduleIdle } from '@/utils/scheduleIdle.js'

const stats = (over: Partial<SyncDrainStats>): SyncDrainStats => ({
  source: 'queue', completed: true, wallMs: 10, windows: 1, rows: 5,
  applied: 5, deferred: 0, skippedStale: 0, quarantined: 0, deleted: 0,
  readMs: 1, decodeMs: 1, writeMs: 1, invalidateMs: 1, bookkeepingMs: 1, ...over,
})

type DrainCb = (s: SyncDrainStats) => void
type StatusCb = (s: { hasSynced?: boolean }) => void

const fakeRepo = (hasSynced: boolean) => {
  let drain: DrainCb | undefined
  let status: StatusCb | undefined
  const disposeStatus = vi.fn()
  let finishDrain!: () => void
  const drained = new Promise<void>((resolve) => { finishDrain = resolve })
  const repo = {
    db: {
      currentStatus: { hasSynced },
      registerListener: (l: { statusChanged: StatusCb }) => { status = l.statusChanged; return disposeStatus },
    },
    onSyncDrainStats: (cb: DrainCb) => { drain = cb; return () => { drain = undefined } },
    flushSyncObserver: () => drained,
  }
  return { repo: repo as never, drain: (s: SyncDrainStats) => drain!(s), status: (s: { hasSynced?: boolean }) => status!(s), disposeStatus, finishDrain, hasDrainListener: () => drain !== undefined }
}

afterEach(() => vi.useRealTimers())

describe('startSyncMetricsCollector', () => {
  it('persists a qualifying drain as a drain record and ignores a small one', async () => {
    const write = vi.fn(async () => 'id')
    const f = fakeRepo(true)
    startSyncMetricsCollector(f.repo, 'ws', { write })

    f.drain(stats({ rows: 10, wallMs: 20 }))
    await new Promise(r => setTimeout(r, 5))
    expect(write).not.toHaveBeenCalled()

    f.drain(stats({ rows: 2000, wallMs: 20 }))
    await vi.waitFor(() => expect(write).toHaveBeenCalledTimes(1))
    const [, workspaceId, data] = write.mock.calls[0] as unknown as [unknown, string, Record<string, unknown>]
    expect(workspaceId).toBe('ws')
    expect(data).toMatchObject({ kind: 'drain', rows: 2000, hasSynced: true })
  })

  it('does not throw into the listener when the write rejects', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const write = vi.fn(async () => { throw new Error('boom') })
    const f = fakeRepo(true)
    startSyncMetricsCollector(f.repo, 'ws', { write })
    expect(() => f.drain(stats({ rows: 5000 }))).not.toThrow()
    await vi.waitFor(() => expect(warn).toHaveBeenCalled())
    warn.mockRestore()
  })

  it('writes one download record once the drain has caught up after hasSynced, then unregisters', async () => {
    const write = vi.fn(async () => 'id')
    const f = fakeRepo(false)
    startSyncMetricsCollector(f.repo, 'ws', { write })
    f.status({ hasSynced: false })
    f.status({ hasSynced: true })
    f.status({ hasSynced: true })
    // Held until the drain has materialized what the download delivered.
    expect(f.disposeStatus).toHaveBeenCalled()
    // An idle turn queued after the status change: an unheld write would have run by now.
    await new Promise<void>((resolve) => { scheduleIdle(() => resolve()) })
    expect(write).not.toHaveBeenCalled()
    f.finishDrain()
    await vi.waitFor(() => expect(write).toHaveBeenCalledTimes(1))
    expect((write.mock.calls[0] as unknown as unknown[])[2]).toMatchObject({ kind: 'download' })
    expect(f.disposeStatus).toHaveBeenCalled()
  })

  it('does not track a download on an already-synced device, and teardown stops the drain listener', () => {
    const f = fakeRepo(true)
    const stop = startSyncMetricsCollector(f.repo, 'ws', { write: vi.fn() })
    expect(() => f.status({ hasSynced: true })).toThrow() // never registered
    stop()
    expect(f.hasDrainListener()).toBe(false)
  })
})
