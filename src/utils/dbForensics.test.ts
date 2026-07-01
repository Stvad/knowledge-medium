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

  it('records lifecycle events on the current session', async () => {
    const f = freshForensics()
    await f.recordSessionStart({ userId: 'u1', dbFilename: 'kmp-v6-u1.db' })
    await f.recordLifecycleEvent('hidden')
    await f.recordLifecycleEvent('visible')
    const all = await f.exportAll()
    const events = (all['session:current'] as { events: Array<{ type: string }> }).events
    expect(events.map(e => e.type)).toEqual(['start', 'hidden', 'visible'])
  })
})

describe('DbForensics — scan + snapshot', () => {
  it('logs a scan and auto-captures a snapshot when a zero page is found', async () => {
    installFakeOpfs({ 'kmp-v6-u1.db': buildDb(8, [5]) })
    const f = freshForensics()
    await f.recordSessionStart({ userId: 'u1', dbFilename: 'kmp-v6-u1.db' })

    const scan = await f.logScan({ userId: 'u1', dbFilename: 'kmp-v6-u1.db' })
    expect(scan?.zeroPageCount).toBe(1)
    expect(scan?.firstZeroPageByteOffset).toBe(4 * 4096)

    const all = await f.exportAll()
    const log = all['scanlog'] as Array<{ zeroPageCount: number }>
    expect(log).toHaveLength(1)
    expect(log[0].zeroPageCount).toBe(1)

    const snapshots = Object.keys(all).filter(k => k.startsWith('snapshot:'))
    expect(snapshots).toHaveLength(1)
    const snap = all[snapshots[0]] as { reason: string; scan: { zeroPageCount: number } }
    expect(snap.reason).toBe('startup-scan-zero-page')
    expect(snap.scan.zeroPageCount).toBe(1)
  })

  it('logs a clean scan without capturing a snapshot', async () => {
    const f = freshForensics()
    await f.logScan({ userId: 'u1', dbFilename: 'kmp-v6-u1.db' })
    const all = await f.exportAll()
    expect((all['scanlog'] as unknown[]).length).toBe(1)
    expect(Object.keys(all).filter(k => k.startsWith('snapshot:'))).toHaveLength(0)
  })

  it('captureCorruptionSnapshot persists OPFS inventory, estimate, and caller SQL context', async () => {
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
})
