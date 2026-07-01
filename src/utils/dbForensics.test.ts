// @vitest-environment jsdom

// File-scoped IndexedDB polyfill (vitest isolates modules per file).
import 'fake-indexeddb/auto'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { IdbKeyedStore } from './idbKeyedStore.js'
import { DbForensics } from './dbForensics.js'

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
