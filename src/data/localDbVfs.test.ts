import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest'
import { WASQLiteVFS } from '@powersync/web'
import {
  LOCAL_DB_VFS_OVERRIDE_KEY,
  LocalDbVfsHandoffError,
  prepareLocalDbForVfs,
  readLocalDbVfsOverride,
  resolveLocalDbVfs,
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
  return {
    calls,
    deps: {
      fileSize: async name => (name in files ? files[name] : null),
      withConnection: async (_dbFilename, vfs, fn) => {
        calls.push(`open:${vfs}`)
        await fn(async sql => {
          calls.push(`sql:${sql}`)
          return undefined
        })
        calls.push(`close:${vfs}`)
      },
      supportsWriteAhead: async () => supportsWriteAhead,
    },
  }
}

describe('resolveLocalDbVfs — the move is one-way, and the sidecars are the record', () => {
  it('keeps a database that already has sidecars on the write-ahead VFS', async () => {
    // Opening it with CoopSync reads the main file as an intact, OLDER database
    // — integrity_check ok, and whatever is still in the log is gone.
    const h = harness({[DB]: 4096, [`${DB}-wa0`]: 20704}, {supportsWriteAhead: false})
    expect(await resolveLocalDbVfs(DB, h.deps)).toBe(WASQLiteVFS.OPFSWriteAheadVFS)
  })

  it('ignores a coop-sync pin for a database that has already moved', async () => {
    const h = harness({[DB]: 4096, [`${DB}-wa1`]: 0})
    vi.stubGlobal('localStorage', {getItem: () => 'coop-sync'})
    try {
      expect(await resolveLocalDbVfs(DB, h.deps)).toBe(WASQLiteVFS.OPFSWriteAheadVFS)
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it('moves a database with no sidecars when the browser supports it', async () => {
    const h = harness({[DB]: 4096})
    expect(await resolveLocalDbVfs(DB, h.deps)).toBe(WASQLiteVFS.OPFSWriteAheadVFS)
  })

  it('leaves it on CoopSync when the browser cannot, or the probe could not say', async () => {
    const h = harness({[DB]: 4096}, {supportsWriteAhead: false})
    expect(await resolveLocalDbVfs(DB, h.deps)).toBe(WASQLiteVFS.OPFSCoopSyncVFS)
  })
})

describe('prepareLocalDbForVfs', () => {
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

  it('does nothing at all for a CoopSync target', async () => {
    // It resolves to CoopSync only with no sidecars, so there is nothing on
    // disk it cannot read — including a hot journal, which it handles itself.
    const h = harness({[DB]: 4096, [`${DB}-journal`]: 8192})
    await prepareLocalDbForVfs(DB, WASQLiteVFS.OPFSCoopSyncVFS, h.deps)
    expect(h.calls).toEqual([])
  })

  it('translates a raw OPFS failure so boot does not show jargon', async () => {
    const h = harness({[DB]: 4096, [`${DB}-journal`]: 8192})
    h.deps.withConnection = async () => {
      throw new DOMException('busy', 'NoModificationAllowedError')
    }
    await expect(prepareLocalDbForVfs(DB, WASQLiteVFS.OPFSWriteAheadVFS, h.deps))
      .rejects.toBeInstanceOf(LocalDbVfsHandoffError)
  })

  it('lets a corruption error through so the bootstrap boundary can classify it', async () => {
    // Rewrapped, the user would get Reload instead of Export + Reset, and every
    // reload would repeat the same failing handoff.
    const h = harness({[DB]: 4096, [`${DB}-journal`]: 8192})
    h.deps.withConnection = async () => {
      throw new Error('database disk image is malformed')
    }
    const error = await prepareLocalDbForVfs(DB, WASQLiteVFS.OPFSWriteAheadVFS, h.deps).catch(e => e)
    expect(error).not.toBeInstanceOf(LocalDbVfsHandoffError)
    expect((error as Error).message).toContain('malformed')
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
