import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest'
import { WASQLiteVFS } from '@powersync/web'
import {
  LOCAL_DB_VFS_OVERRIDE_KEY,
  resolveLocalDbVfs,
  type WriteAheadSupport,
  LocalDbVfsHandoffError,
  prepareLocalDbForVfs,
  readLocalDbVfsOverride,
  type LocalDbVfsHandoffDeps,
} from './localDbVfs'

const DB = 'kmp-v6-test.db'

interface Harness {
  deps: LocalDbVfsHandoffDeps
  calls: string[]
}

// `PRAGMA wal_checkpoint` answers with one cell whose column name IS the value.
const checkpointResult = (pages: number) => ({
  rows: {_array: [{[String(pages)]: String(pages)}]},
})

const harness = (
  files: Record<string, number>,
  {
    writeAheadSupport = 'supported',
    pagesLeftAfterCheckpoint = 0,
  }: {writeAheadSupport?: WriteAheadSupport; pagesLeftAfterCheckpoint?: number} = {},
): Harness => {
  const calls: string[] = []
  const present = {...files}
  return {
    calls,
    deps: {
      fileSize: async name => (name in present ? present[name] : null),
      removeFile: async name => {
        calls.push(`remove:${name}`)
        delete present[name]
      },
      withConnection: async (_dbFilename, vfs, fn) => {
        calls.push(`open:${vfs}`)
        await fn(async sql => {
          calls.push(`sql:${sql}`)
          if (sql === 'PRAGMA wal_checkpoint=truncate') return checkpointResult(377)
          if (sql === 'PRAGMA wal_checkpoint=noop') return checkpointResult(pagesLeftAfterCheckpoint)
          return undefined
        })
        calls.push(`close:${vfs}`)
      },
      writeAheadSupport: async () => writeAheadSupport,
    },
  }
}

describe('prepareLocalDbForVfs — upgrade to the write-ahead VFS', () => {
  it('does nothing when the previous session shut down cleanly', async () => {
    // A clean CoopSync close leaves a zero-byte `-journal` behind.
    const h = harness({[DB]: 4096, [`${DB}-journal`]: 0})
    await prepareLocalDbForVfs(DB, WASQLiteVFS.OPFSWriteAheadVFS, h.deps)
    expect(h.calls).toEqual([])
  })

  it('lets CoopSync roll back a hot journal first, because the write-ahead VFS never sees one', async () => {
    const h = harness({[DB]: 4096, [`${DB}-journal`]: 8192})
    await prepareLocalDbForVfs(DB, WASQLiteVFS.OPFSWriteAheadVFS, h.deps)
    expect(h.calls).toEqual([
      `open:${WASQLiteVFS.OPFSCoopSyncVFS}`,
      'sql:PRAGMA user_version',
      `close:${WASQLiteVFS.OPFSCoopSyncVFS}`,
    ])
  })
})

describe('prepareLocalDbForVfs — downgrade to CoopSync', () => {
  it('does nothing when no write-ahead sidecars exist', async () => {
    const h = harness({[DB]: 4096, [`${DB}-journal`]: 0})
    await prepareLocalDbForVfs(DB, WASQLiteVFS.OPFSCoopSyncVFS, h.deps)
    expect(h.calls).toEqual([])
  })

  it('checkpoints the sidecars into the main file and only then deletes them', async () => {
    const h = harness({[DB]: 4096, [`${DB}-wa0`]: 20704, [`${DB}-wa1`]: 0})
    await prepareLocalDbForVfs(DB, WASQLiteVFS.OPFSCoopSyncVFS, h.deps)
    expect(h.calls).toEqual([
      `open:${WASQLiteVFS.OPFSWriteAheadVFS}`,
      'sql:PRAGMA wal_checkpoint=truncate',
      'sql:PRAGMA wal_checkpoint=noop',
      `close:${WASQLiteVFS.OPFSWriteAheadVFS}`,
      `remove:${DB}-wa0`,
      `remove:${DB}-wa1`,
    ])
  })

  it('deletes BOTH sidecars — the handoff connection recreates whichever was missing', async () => {
    const h = harness({[DB]: 4096, [`${DB}-wa1`]: 0})
    await prepareLocalDbForVfs(DB, WASQLiteVFS.OPFSCoopSyncVFS, h.deps)
    expect(h.calls).toContain(`remove:${DB}-wa0`)
    expect(h.calls).toContain(`remove:${DB}-wa1`)
  })

  it('refuses when the checkpoint drained only part of the log', async () => {
    const h = harness({[DB]: 4096, [`${DB}-wa0`]: 20704}, {pagesLeftAfterCheckpoint: 12})
    await expect(prepareLocalDbForVfs(DB, WASQLiteVFS.OPFSCoopSyncVFS, h.deps))
      .rejects.toBeInstanceOf(LocalDbVfsHandoffError)
    expect(h.calls.filter(c => c.startsWith('remove:'))).toEqual([])
  })

  it('refuses when the checkpoint result cannot be read — unproven is not empty', async () => {
    const h = harness({[DB]: 4096, [`${DB}-wa0`]: 20704})
    const inner = h.deps.withConnection
    h.deps.withConnection = (dbFilename, vfs, fn) =>
      inner(dbFilename, vfs, async execute => {
        await fn(async sql => {
          await execute(sql)
          return {unexpected: 'shape'}
        })
      })
    await expect(prepareLocalDbForVfs(DB, WASQLiteVFS.OPFSCoopSyncVFS, h.deps))
      .rejects.toBeInstanceOf(LocalDbVfsHandoffError)
    expect(h.calls.filter(c => c.startsWith('remove:'))).toEqual([])
  })

  it('refuses rather than dropping sidecar commits it cannot checkpoint', async () => {
    const h = harness({[DB]: 4096, [`${DB}-wa0`]: 20704}, {writeAheadSupport: 'unsupported'})
    await expect(prepareLocalDbForVfs(DB, WASQLiteVFS.OPFSCoopSyncVFS, h.deps))
      .rejects.toBeInstanceOf(LocalDbVfsHandoffError)
    expect(h.calls).toEqual([])
  })
})

describe('readLocalDbVfsOverride', () => {
  const store = new Map<string, string>()

  beforeEach(() => {
    store.clear()
    vi.stubGlobal('localStorage', {
      getItem: (key: string) => store.get(key) ?? null,
      setItem: (key: string, value: string) => void store.set(key, value),
    })
  })
  afterEach(() => vi.unstubAllGlobals())

  it('maps the pinned values and ignores anything else', () => {
    expect(readLocalDbVfsOverride()).toBeNull()

    localStorage.setItem(LOCAL_DB_VFS_OVERRIDE_KEY, 'write-ahead')
    expect(readLocalDbVfsOverride()).toBe(WASQLiteVFS.OPFSWriteAheadVFS)

    localStorage.setItem(LOCAL_DB_VFS_OVERRIDE_KEY, 'coop-sync')
    expect(readLocalDbVfsOverride()).toBe(WASQLiteVFS.OPFSCoopSyncVFS)

    // An unrecognised pin must fall through to the probe, not to a wrong VFS.
    localStorage.setItem(LOCAL_DB_VFS_OVERRIDE_KEY, 'OPFSWriteAheadVFS')
    expect(readLocalDbVfsOverride()).toBeNull()
  })

  it('survives storage that throws (private mode)', () => {
    vi.stubGlobal('localStorage', {
      getItem: () => { throw new DOMException('denied', 'SecurityError') },
    })
    expect(readLocalDbVfsOverride()).toBeNull()
  })
})


describe('resolveLocalDbVfs — an inconclusive probe is not a "no"', () => {
  const resolveWith = (support: WriteAheadSupport, files: Record<string, number>) =>
    resolveLocalDbVfs(DB, {
      fileSize: async name => (name in files ? files[name] : null),
      writeAheadSupport: async () => support,
    })

  it('keeps using the write-ahead VFS when the probe failed but its sidecars exist', async () => {
    // The sidecars are proof this device ran the write-ahead VFS before, so a
    // probe that merely failed to RUN must not route to CoopSync — the
    // downgrade would then refuse (it cannot checkpoint) and boot would fail.
    expect(await resolveWith('unknown', {[DB]: 4096, [`${DB}-wa0`]: 20704}))
      .toBe(WASQLiteVFS.OPFSWriteAheadVFS)
  })

  it('falls back to CoopSync on an inconclusive probe when there is nothing to lose', async () => {
    expect(await resolveWith('unknown', {[DB]: 4096}))
      .toBe(WASQLiteVFS.OPFSCoopSyncVFS)
  })

  it('honours a definitive no even with sidecars present, so the downgrade can run', async () => {
    expect(await resolveWith('unsupported', {[DB]: 4096, [`${DB}-wa0`]: 20704}))
      .toBe(WASQLiteVFS.OPFSCoopSyncVFS)
  })

  it('uses the write-ahead VFS when the probe says yes', async () => {
    expect(await resolveWith('supported', {[DB]: 4096}))
      .toBe(WASQLiteVFS.OPFSWriteAheadVFS)
  })
})
