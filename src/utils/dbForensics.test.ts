// @vitest-environment happy-dom

// File-scoped IndexedDB polyfill (vitest isolates modules per file).
import 'fake-indexeddb/auto'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { IdbKeyedStore } from './idbKeyedStore.js'
import {
  DbForensics,
  MAX_STALL_EPISODES,
  MAX_SYNC_ARCHIVES,
  MAX_SYNC_SAMPLES,
  type SyncHealthSample,
} from './dbForensics.js'

let counter = 0
const freshForensics = () => new DbForensics(new IdbKeyedStore(`km-forensics-test-${++counter}`, 'forensics'))

// Minimal SQLite-ish image: `pageCount` pages of 4096 bytes, `zeroPages`
// (1-indexed) left all-zero, header page size at bytes 16-17.
const buildDb = (pageCount: number, zeroPages: number[]): Uint8Array => {
  const pageSize = 4096
  const buf = new Uint8Array(pageSize * pageCount)
  const zero = new Set(zeroPages)
  for (let page = 1; page <= pageCount; page++) {
    if (zero.has(page)) continue
    const base = (page - 1) * pageSize
    buf[base] = 0x0d
    for (let i = 1; i < pageSize; i++) buf[base + i] = (i % 251) + 1
  }
  buf[16] = (pageSize >> 8) & 0xff
  buf[17] = pageSize & 0xff
  return buf
}

const fakeFile = (bytes: Uint8Array) => ({
  size: bytes.byteLength,
  slice: (s: number, e: number) => ({ arrayBuffer: async () => bytes.slice(s, e).buffer }),
})

const originalStorage = Object.getOwnPropertyDescriptor(navigator, 'storage')

const installFakeOpfs = (files: Record<string, Uint8Array>) => {
  const handleFor = (name: string) => ({
    kind: 'file' as const,
    getFile: async () => fakeFile(files[name]),
  })
  const dir = {
    getFileHandle: async (name: string) => {
      if (!(name in files)) throw new DOMException('not found', 'NotFoundError')
      return handleFor(name)
    },
    entries: async function* () {
      for (const name of Object.keys(files)) yield [name, handleFor(name)] as [string, unknown]
    },
  }
  Object.defineProperty(navigator, 'storage', {
    configurable: true,
    value: { getDirectory: async () => dir, estimate: async () => ({ usage: 100, quota: 1000 }) },
  })
}

beforeEach(() => installFakeOpfs({ 'kmp-v6-u1.db': buildDb(8, []) }))
afterEach(() => {
  if (originalStorage) Object.defineProperty(navigator, 'storage', originalStorage)
})

describe('DbForensics — unclean-shutdown detection', () => {
  it('first session start is clean and records dbSizeAtStart', async () => {
    const f = freshForensics()
    const result = await f.recordSessionStart({ userId: 'u1', dbFilename: 'kmp-v6-u1.db' })
    expect(result.uncleanShutdown).toBe(false)
    expect(result.uncleanShutdownCount).toBe(0)

    const all = await f.exportAll()
    const session = all['session:current'] as { cleanShutdown: boolean; dbSizeAtStart: number }
    expect(session.cleanShutdown).toBe(false)
    expect(session.dbSizeAtStart).toBe(8 * 4096)
  })

  it('a second start with no clean shutdown between is flagged unclean and archived', async () => {
    const f = freshForensics()
    await f.recordSessionStart({ userId: 'u1', dbFilename: 'kmp-v6-u1.db' })
    const result = await f.recordSessionStart({ userId: 'u1', dbFilename: 'kmp-v6-u1.db' })

    expect(result.uncleanShutdown).toBe(true)
    expect(result.uncleanShutdownCount).toBe(1)

    const all = await f.exportAll()
    const archived = Object.keys(all).filter(k => k.startsWith('unclean:'))
    expect(archived).toHaveLength(1)
  })

  it('a clean shutdown between starts is NOT flagged unclean', async () => {
    const f = freshForensics()
    await f.recordSessionStart({ userId: 'u1', dbFilename: 'kmp-v6-u1.db' })
    await f.markCleanShutdown()
    const result = await f.recordSessionStart({ userId: 'u1', dbFilename: 'kmp-v6-u1.db' })
    expect(result.uncleanShutdown).toBe(false)
    expect(result.uncleanShutdownCount).toBe(0)
  })

  it('records lifecycle events + lastVisibilityState on the current session', async () => {
    const f = freshForensics()
    await f.recordSessionStart({ userId: 'u1', dbFilename: 'kmp-v6-u1.db' })
    await f.recordLifecycleEvent('visibility:hidden')
    await f.recordLifecycleEvent('freeze')
    const all = await f.exportAll()
    const session = all['session:current'] as {
      events: Array<{ type: string }>
      lastVisibilityState: string | null
    }
    expect(session.events.map(e => e.type)).toEqual(['start', 'visibility:hidden', 'freeze'])
    expect(session.lastVisibilityState).toBe('hidden')
  })

  it('clearCleanShutdown flips a clean session back to unclean (bfcache resurrection)', async () => {
    const f = freshForensics()
    await f.recordSessionStart({ userId: 'u1', dbFilename: 'kmp-v6-u1.db' })
    await f.markCleanShutdown()
    await f.clearCleanShutdown()
    const result = await f.recordSessionStart({ userId: 'u1', dbFilename: 'kmp-v6-u1.db' })
    // The resurrected-then-killed session must count as unclean.
    expect(result.uncleanShutdown).toBe(true)
  })

  it('serializes session writes so an interleaved event cannot clobber clean-shutdown', async () => {
    const f = freshForensics()
    await f.recordSessionStart({ userId: 'u1', dbFilename: 'kmp-v6-u1.db' })
    // Fire without awaiting between — models visibilitychange + pagehide racing.
    await Promise.all([f.markCleanShutdown(), f.recordLifecycleEvent('visibility:hidden')])
    const all = await f.exportAll()
    expect((all['session:current'] as { cleanShutdown: boolean }).cleanShutdown).toBe(true)
  })
})

describe('DbForensics — corruption snapshot', () => {
  it('persists OPFS inventory, estimate, scan, and caller SQL context', async () => {
    const f = freshForensics()
    await f.recordSessionStart({ userId: 'u1', dbFilename: 'kmp-v6-u1.db' })
    const snap = await f.captureCorruptionSnapshot({
      userId: 'u1',
      dbFilename: 'kmp-v6-u1.db',
      reason: 'runtime-sync-corrupt',
      sql: { downloadError: 'powersync_control: internal SQLite call returned CORRUPT' },
    })

    expect(snap?.reason).toBe('runtime-sync-corrupt')
    expect(snap?.estimate).toEqual({ usage: 100, quota: 1000 })
    expect(snap?.sql).toEqual({ downloadError: 'powersync_control: internal SQLite call returned CORRUPT' })
    const inventory = snap?.opfs as Array<{ name: string; size: number | null }>
    expect(inventory.some(e => e.name === 'kmp-v6-u1.db' && e.size === 8 * 4096)).toBe(true)
  })

  it('does not read block content — scan stores only counts/offsets, never page bytes', async () => {
    installFakeOpfs({ 'kmp-v6-u1.db': buildDb(8, [5]) })
    const f = freshForensics()
    const snap = await f.captureCorruptionSnapshot({ userId: 'u1', dbFilename: 'kmp-v6-u1.db', reason: 'x' })
    const scan = snap?.scan as { zeroPageCount: number; firstZeroPageByteOffset: number }
    expect(scan.zeroPageCount).toBe(1)
    expect(scan.firstZeroPageByteOffset).toBe(4 * 4096)
    expect(Object.keys(scan)).not.toContain('bytes')
  })

  it('two same-millisecond captures do not overwrite each other', async () => {
    const f = freshForensics()
    // Same reason, effectively same ms — distinct keys via the monotonic suffix.
    await Promise.all([
      f.captureCorruptionSnapshot({ userId: 'u1', dbFilename: 'kmp-v6-u1.db', reason: 'r' }),
      f.captureCorruptionSnapshot({ userId: 'u1', dbFilename: 'kmp-v6-u1.db', reason: 'r' }),
    ])
    const all = await f.exportAll()
    expect(Object.keys(all).filter(k => k.startsWith('snapshot:'))).toHaveLength(2)
  })
})

// A minimal complete sample, so each test only overrides the field(s) it cares
// about. `t` defaults to 1000 — tests that record multiple samples override it
// per call so `lastT`/coalescing behavior is legible from the numbers.
const baseSyncSample = (
  overrides: Partial<Omit<SyncHealthSample, 'lastT' | 'count'>> = {},
): Omit<SyncHealthSample, 'lastT' | 'count'> => ({
  t: 1000,
  connected: true,
  connecting: false,
  hasSynced: true,
  lastSyncedAt: 1000,
  uploading: false,
  downloading: false,
  pendingRows: 0,
  pendingBlocks: 0,
  pendingSinceT: null,
  rejected: 0,
  materializing: 0,
  uploadError: null,
  downloadError: null,
  stall: false,
  ...overrides,
})

describe('DbForensics — sync-health sample ring', () => {
  it('identical consecutive samples coalesce into one entry (count advances, t is preserved)', async () => {
    const f = freshForensics()
    await f.recordSyncSample(baseSyncSample({ t: 1000 }))
    await f.recordSyncSample(baseSyncSample({ t: 2000 }))
    await f.recordSyncSample(baseSyncSample({ t: 3000 }))

    const all = await f.exportAll()
    const ring = all['sync:current'] as { samples: SyncHealthSample[] }
    expect(ring.samples).toHaveLength(1)
    expect(ring.samples[0]).toMatchObject({ t: 1000, lastT: 3000, count: 3 })
  })

  it('a single changed field appends a second entry instead of coalescing', async () => {
    const f = freshForensics()
    await f.recordSyncSample(baseSyncSample({ t: 1000, connected: true }))
    await f.recordSyncSample(baseSyncSample({ t: 2000, connected: false }))

    const all = await f.exportAll()
    const ring = all['sync:current'] as { samples: SyncHealthSample[] }
    expect(ring.samples).toHaveLength(2)
    expect(ring.samples[0]).toMatchObject({ t: 1000, lastT: 1000, count: 1, connected: true })
    expect(ring.samples[1]).toMatchObject({ t: 2000, lastT: 2000, count: 1, connected: false })
  })

  it('the 16-hour-stall shape: 963 identical observations collapse into one entry', async () => {
    const f = freshForensics()
    for (let i = 0; i < 963; i++) {
      await f.recordSyncSample(baseSyncSample({
        t: 1000 + i * 60_000,
        connected: false,
        pendingBlocks: 22,
        pendingRows: 22,
        stall: true,
      }))
    }
    const all = await f.exportAll()
    const ring = all['sync:current'] as { samples: SyncHealthSample[] }
    expect(ring.samples).toHaveLength(1)
    expect(ring.samples[0].count).toBe(963)
  })

  it('ring caps at MAX_SYNC_SAMPLES, dropping the oldest entries', async () => {
    const f = freshForensics()
    for (let i = 0; i < MAX_SYNC_SAMPLES + 5; i++) {
      // Each sample differs from its predecessor (pendingRows increments) so
      // every call appends rather than coalescing.
      await f.recordSyncSample(baseSyncSample({ t: i, pendingRows: i }))
    }
    const all = await f.exportAll()
    const ring = all['sync:current'] as { samples: SyncHealthSample[] }
    expect(ring.samples).toHaveLength(MAX_SYNC_SAMPLES)
    expect(ring.samples[0].t).toBe(5) // oldest 5 dropped
    expect(ring.samples[ring.samples.length - 1].t).toBe(MAX_SYNC_SAMPLES + 4)
  })

  it('recordSessionStart archives the previous ring under a distinct prefix and resets sync:current', async () => {
    const f = freshForensics()
    await f.recordSessionStart({ userId: 'u1', dbFilename: 'kmp-v6-u1.db' })
    await f.recordSyncSample(baseSyncSample({ t: 1000, pendingBlocks: 22 }))
    await f.recordSyncSample(baseSyncSample({ t: 2000, pendingBlocks: 22, connected: false }))

    const before = (await f.exportAll())['sync:current'] as { startedAt: number; samples: unknown[] }
    expect(before.samples).toHaveLength(2)

    await f.recordSessionStart({ userId: 'u1', dbFilename: 'kmp-v6-u1.db' })

    const all = await f.exportAll()
    const archivedKeys = Object.keys(all).filter(k => k.startsWith('syncsession:'))
    expect(archivedKeys).toHaveLength(1)
    const archived = all[archivedKeys[0]] as { startedAt: number; samples: unknown[] }
    expect(archived.startedAt).toBe(before.startedAt)
    expect(archived.samples).toHaveLength(2)

    const current = all['sync:current'] as { samples: unknown[] }
    expect(current.samples).toEqual([])
  })

  it('archive trimming caps at MAX_SYNC_ARCHIVES but never deletes sync:current', async () => {
    const f = freshForensics()
    for (let i = 0; i < MAX_SYNC_ARCHIVES + 3; i++) {
      await f.recordSessionStart({ userId: 'u1', dbFilename: 'kmp-v6-u1.db' })
      await f.recordSyncSample(baseSyncSample({ t: i, pendingRows: i }))
      await f.markCleanShutdown()
    }
    const all = await f.exportAll()
    expect(all['sync:current']).toBeDefined()
    const current = all['sync:current'] as { samples: unknown[] }
    // The most recent session's own sample is still there — never swept by the trim.
    expect(current.samples).toHaveLength(1)

    const archivedKeys = Object.keys(all).filter(k => k.startsWith('syncsession:'))
    expect(archivedKeys.length).toBeGreaterThan(0)
    expect(archivedKeys.length).toBeLessThanOrEqual(MAX_SYNC_ARCHIVES)
    expect(archivedKeys).not.toContain('sync:current')
  })

  it('a store that throws does not reject recordSyncSample', async () => {
    const throwingStore = {
      tx: async () => { throw new Error('boom') },
      scanByPrefix: async () => { throw new Error('boom') },
    } as unknown as IdbKeyedStore
    const f = new DbForensics(throwingStore)
    await expect(f.recordSyncSample(baseSyncSample())).resolves.toBeUndefined()
    // Confirm the store really is unusable — this isn't accidentally passing
    // because the store secretly works.
    const all = await f.exportAll()
    expect(all).toEqual({})
  })

  it('healthy churn in lastSyncedAt/uploading/downloading does not fragment the ring, and the retained entry updates to the newest value', async () => {
    const f = freshForensics()
    await f.recordSyncSample(baseSyncSample({ t: 1000, lastSyncedAt: 1000, uploading: true, downloading: false }))
    await f.recordSyncSample(baseSyncSample({ t: 2000, lastSyncedAt: 2000, uploading: false, downloading: true }))
    await f.recordSyncSample(baseSyncSample({ t: 3000, lastSyncedAt: 3000, uploading: false, downloading: false }))

    const all = await f.exportAll()
    const ring = all['sync:current'] as { samples: SyncHealthSample[] }
    // One absorbing entry, not three — these three fields churn on every
    // checkpoint even on a healthy connection and must not be part of the
    // coalescing key.
    expect(ring.samples).toHaveLength(1)
    // The retained entry reflects the NEWEST observation ("as of lastT"), not
    // whatever it happened to be when the entry was first created.
    expect(ring.samples[0]).toMatchObject({
      t: 1000, lastT: 3000, count: 3,
      lastSyncedAt: 3000, uploading: false, downloading: false,
    })
  })

  it('a change in pendingSinceT (a new pending-queue episode) still appends a new entry', async () => {
    const f = freshForensics()
    // Same pendingBlocks both times, but the queue drained and refilled
    // between samples — a genuinely new episode, not a continuation.
    await f.recordSyncSample(baseSyncSample({ t: 1000, pendingBlocks: 5, pendingSinceT: 1000 }))
    await f.recordSyncSample(baseSyncSample({ t: 2000, pendingBlocks: 5, pendingSinceT: 2000 }))

    const all = await f.exportAll()
    const ring = all['sync:current'] as { samples: SyncHealthSample[] }
    expect(ring.samples).toHaveLength(2)
  })
})

describe('DbForensics — stall episodes', () => {
  it('recordStallEpisode writes the triggering sample under stall:<t>', async () => {
    const f = freshForensics()
    const key = await f.recordStallEpisode(baseSyncSample({ t: 1000, pendingBlocks: 22, stall: true }))
    expect(key).toBe('stall:1000')

    const all = await f.exportAll()
    expect(all[key as string]).toMatchObject({ t: 1000, pendingBlocks: 22, stall: true })
    expect(all[key as string]).not.toHaveProperty('clearedAt')
  })

  it('closeStallEpisode patches how the stall resolved, without touching the opening fields', async () => {
    const f = freshForensics()
    const key = await f.recordStallEpisode(baseSyncSample({ t: 1000, pendingBlocks: 22, connected: false }))
    await f.closeStallEpisode(key, { clearedAt: 5000, connected: true, lastSyncedAt: 5000, pendingBlocks: 0 })

    const all = await f.exportAll()
    expect(all[key as string]).toMatchObject({
      t: 1000, pendingBlocks: 22, connected: false, // opening state, unchanged
      clearedAt: 5000, clearedConnected: true, clearedLastSyncedAt: 5000, clearedPendingBlocks: 0,
    })
  })

  it('closeStallEpisode is a no-op when key is null', async () => {
    const f = freshForensics()
    await expect(
      f.closeStallEpisode(null, { clearedAt: 1, connected: true, lastSyncedAt: null, pendingBlocks: 0 }),
    ).resolves.toBeUndefined()
    expect(await f.exportAll()).toEqual({})
  })

  it('caps at MAX_STALL_EPISODES, dropping the oldest', async () => {
    const f = freshForensics()
    for (let i = 0; i < MAX_STALL_EPISODES + 3; i++) {
      await f.recordStallEpisode(baseSyncSample({ t: 1000 + i, pendingBlocks: 1 }))
    }
    const all = await f.exportAll()
    const keys = Object.keys(all).filter(k => k.startsWith('stall:'))
    expect(keys).toHaveLength(MAX_STALL_EPISODES)
  })

  it('a store that throws does not reject recordStallEpisode or closeStallEpisode', async () => {
    const throwingStore = {
      tx: async () => { throw new Error('boom') },
      scanByPrefix: async () => { throw new Error('boom') },
    } as unknown as IdbKeyedStore
    const f = new DbForensics(throwingStore)
    await expect(f.recordStallEpisode(baseSyncSample())).resolves.toBeNull()
    await expect(
      f.closeStallEpisode('stall:1', { clearedAt: 1, connected: true, lastSyncedAt: null, pendingBlocks: 0 }),
    ).resolves.toBeUndefined()
  })
})
