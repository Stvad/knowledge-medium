import { describe, expect, it, vi } from 'vitest'
import { flushUploadQueue } from './flushUploadQueue.js'

// A fake clock + immediate sleep so the polling flush runs instantly in tests.
const immediate = {
  sleep: async () => {},
  now: () => 0,
}

describe('flushUploadQueue', () => {
  it('reports flushed immediately when the queue is already empty (no waiting)', async () => {
    const getUploadQueueStats = vi.fn().mockResolvedValue({ count: 0 })
    const db = { getUploadQueueStats, currentStatus: { connected: true } }

    const result = await flushUploadQueue(db, immediate)

    expect(result).toEqual({ flushed: true, remaining: 0 })
    // Only the initial probe — no poll loop for an already-drained queue.
    expect(getUploadQueueStats).toHaveBeenCalledTimes(1)
  })

  it('polls until the queue drains while connected, then reports flushed', async () => {
    // 3 → 2 → 0 across successive probes; PowerSync uploads in the background.
    const getUploadQueueStats = vi
      .fn()
      .mockResolvedValueOnce({ count: 3 })
      .mockResolvedValueOnce({ count: 2 })
      .mockResolvedValueOnce({ count: 0 })
    const db = { getUploadQueueStats, currentStatus: { connected: true } }

    const result = await flushUploadQueue(db, immediate)

    expect(result).toEqual({ flushed: true, remaining: 0 })
    expect(getUploadQueueStats).toHaveBeenCalledTimes(3)
  })

  it('forces an immediate upload while draining instead of waiting on the scheduler', async () => {
    const getUploadQueueStats = vi
      .fn()
      .mockResolvedValueOnce({ count: 2 })
      .mockResolvedValueOnce({ count: 0 })
    const triggerCrudUpload = vi.fn()
    const db = {
      getUploadQueueStats,
      currentStatus: { connected: true },
      syncStreamImplementation: { triggerCrudUpload },
    }

    const result = await flushUploadQueue(db, immediate)

    expect(result).toEqual({ flushed: true, remaining: 0 })
    // The point of the feature: we don't sit waiting for PowerSync's throttled
    // background upload — we push it.
    expect(triggerCrudUpload).toHaveBeenCalled()
  })

  it('does not force uploads when offline (the trigger would be a no-op anyway)', async () => {
    const getUploadQueueStats = vi.fn().mockResolvedValue({ count: 3 })
    const triggerCrudUpload = vi.fn()
    const db = {
      getUploadQueueStats,
      currentStatus: { connected: false },
      syncStreamImplementation: { triggerCrudUpload },
    }

    const result = await flushUploadQueue(db, immediate)

    expect(result).toEqual({ flushed: false, remaining: 3 })
    expect(triggerCrudUpload).not.toHaveBeenCalled()
  })

  it('reports NOT flushed (with the stuck count) when offline — never waits pointlessly', async () => {
    const getUploadQueueStats = vi.fn().mockResolvedValue({ count: 5 })
    const db = { getUploadQueueStats, currentStatus: { connected: false } }

    const result = await flushUploadQueue(db, immediate)

    expect(result).toEqual({ flushed: false, remaining: 5 })
  })

  it('reports NOT flushed once the timeout elapses while uploads stay stuck', async () => {
    // Connected, but the queue never drains (e.g. server keeps rejecting).
    const getUploadQueueStats = vi.fn().mockResolvedValue({ count: 2 })
    let t = 0
    const db = { getUploadQueueStats, currentStatus: { connected: true } }

    const result = await flushUploadQueue(db, {
      sleep: async () => {},
      now: () => (t += 1000), // each call jumps 1s; default timeout is short here
      timeoutMs: 1500,
      pollMs: 1,
    })

    expect(result).toEqual({ flushed: false, remaining: 2 })
  })
})
