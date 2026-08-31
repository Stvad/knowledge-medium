import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest'
import { WASQLiteVFS } from '@powersync/web'
import {
  LOCAL_DB_VFS_OVERRIDE_KEY,
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

const harness = (
  files: Record<string, number>,
  {supportsWriteAhead = true}: {supportsWriteAhead?: boolean} = {},
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
        })
        calls.push(`close:${vfs}`)
      },
      supportsWriteAhead: async () => supportsWriteAhead,
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
      `close:${WASQLiteVFS.OPFSWriteAheadVFS}`,
      `remove:${DB}-wa0`,
      `remove:${DB}-wa1`,
    ])
  })

  it('deletes a zero-byte sidecar too — a stale log replays over later CoopSync writes', async () => {
    const h = harness({[DB]: 4096, [`${DB}-wa1`]: 0})
    await prepareLocalDbForVfs(DB, WASQLiteVFS.OPFSCoopSyncVFS, h.deps)
    expect(h.calls).toContain(`remove:${DB}-wa1`)
  })

  it('refuses rather than dropping sidecar commits it cannot checkpoint', async () => {
    const h = harness({[DB]: 4096, [`${DB}-wa0`]: 20704}, {supportsWriteAhead: false})
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
