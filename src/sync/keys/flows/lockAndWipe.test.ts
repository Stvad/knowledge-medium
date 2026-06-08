import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { InMemoryWorkspaceKeyStore } from '../keyStore.js'
import { getModePin, setModePin } from '../modePin.js'
import {
  clearPendingWipe,
  consumePendingWipe,
  flushUploadQueue,
  isPendingWipe,
  lockAndWipe,
  markPendingWipe,
} from './lockAndWipe.js'

const USER = 'user-1'

beforeEach(() => localStorage.clear())
afterEach(() => localStorage.clear())

// A fake clock + immediate sleep so the polling flush runs instantly in tests.
const immediate = {
  sleep: async () => {},
  now: () => 0,
}

describe('flushUploadQueue (§6)', () => {
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

describe('pending-wipe marker (§6)', () => {
  it('round-trips per user and is independent across users', () => {
    expect(isPendingWipe(USER)).toBe(false)

    markPendingWipe(USER)
    expect(isPendingWipe(USER)).toBe(true)
    expect(isPendingWipe('other-user')).toBe(false)

    clearPendingWipe(USER)
    expect(isPendingWipe(USER)).toBe(false)
  })
})

describe('lockAndWipe commit (§6)', () => {
  it('drops every workspace key and arms the pending-wipe marker', async () => {
    const keyStore = new InMemoryWorkspaceKeyStore()
    const clearAll = vi.spyOn(keyStore, 'clearAll')

    await lockAndWipe({ userId: USER, keyStore })

    expect(clearAll).toHaveBeenCalledTimes(1)
    expect(isPendingWipe(USER)).toBe(true)
  })

  it('preserves mode pins so the wipe can never downgrade an e2ee workspace', async () => {
    const keyStore = new InMemoryWorkspaceKeyStore()
    setModePin(USER, 'ws-e2ee', 'e2ee')
    setModePin(USER, 'ws-plain', 'plaintext')

    await lockAndWipe({ userId: USER, keyStore })

    // The pin is the wipe-surviving authority — both must remain after the wipe.
    expect(getModePin(USER, 'ws-e2ee')).toBe('e2ee')
    expect(getModePin(USER, 'ws-plain')).toBe('plaintext')
  })

  it('refuses (no key drop, no marker) when localStorage cannot arm the wipe', async () => {
    // If we cannot persist the marker, the next boot would not wipe the DB —
    // so we must refuse BEFORE dropping keys, rather than leave plaintext on
    // disk with no scheduled wipe. Mirrors the create-flow storage preflight.
    const keyStore = new InMemoryWorkspaceKeyStore()
    const clearAll = vi.spyOn(keyStore, 'clearAll')
    const spy = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('localStorage is blocked')
    })
    try {
      await expect(lockAndWipe({ userId: USER, keyStore })).rejects.toThrow(/storage/i)
      expect(clearAll).not.toHaveBeenCalled()
      expect(isPendingWipe(USER)).toBe(false)
    } finally {
      spy.mockRestore()
    }
  })

  it('does not arm the wipe when the key-store clear fails (no half-state)', async () => {
    const failingStore = {
      get: async () => null,
      put: async () => {},
      delete: async () => {},
      clearAll: async () => {
        throw new Error('IndexedDB clear failed')
      },
    }

    await expect(lockAndWipe({ userId: USER, keyStore: failingStore })).rejects.toThrow(
      /IndexedDB clear failed/,
    )
    expect(isPendingWipe(USER)).toBe(false)
  })
})

describe('consumePendingWipe (boot-time, §6)', () => {
  const resolveFilename = (userId: string) => `kmp-v6-${userId}.db`

  it('does nothing when no wipe is armed', async () => {
    const remove = vi.fn().mockResolvedValue(undefined)

    const wiped = await consumePendingWipe(USER, remove, resolveFilename)

    expect(wiped).toBe(false)
    expect(remove).not.toHaveBeenCalled()
  })

  it('removes the user DB file, then clears the marker', async () => {
    markPendingWipe(USER)
    const remove = vi.fn().mockResolvedValue(undefined)

    const wiped = await consumePendingWipe(USER, remove, resolveFilename)

    expect(wiped).toBe(true)
    expect(remove).toHaveBeenCalledWith('kmp-v6-user-1.db')
    expect(isPendingWipe(USER)).toBe(false)
  })

  it('leaves the marker armed when removal fails, so the next boot retries', async () => {
    markPendingWipe(USER)
    const remove = vi.fn().mockRejectedValue(new Error('OPFS removeEntry failed'))

    await expect(consumePendingWipe(USER, remove, resolveFilename)).rejects.toThrow(
      /OPFS removeEntry failed/,
    )
    // Marker must NOT be cleared — opening a DB that still holds the wiped
    // plaintext would break the security promise; retry on next boot instead.
    expect(isPendingWipe(USER)).toBe(true)
  })
})
