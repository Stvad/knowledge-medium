import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest'
import { WASQLiteVFS } from '@powersync/web'
import {
  asLostWriteAheadSupport,
  handoffErrorUserId,
  LOCAL_DB_VFS_OVERRIDE_KEY,
  LocalDbVfsHandoffError,
  prepareLocalDbForVfs,
  readLocalDbVfsOverride,
  resolveLocalDbVfs,
  tagHandoffErrorUserId,
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
      withConnection: async (_dbFilename, fn) => {
        calls.push('open')
        await fn(async sql => {
          calls.push(`sql:${sql}`)
          return undefined
        })
        calls.push('close')
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

  it('re-checks for sidecars before settling on CoopSync, in case another tab moved it', async () => {
    // The probe can take seconds; another tab reaching a different answer in
    // that window moves the database and creates the log. Opening CoopSync over
    // a live log is the one outcome that must never happen.
    let probed = false
    const files: Record<string, number> = {[DB]: 4096}
    const vfs = await resolveLocalDbVfs(DB, {
      fileSize: async name => (name in files ? files[name] : null),
      supportsWriteAhead: async () => {
        probed = true
        files[`${DB}-wa0`] = 0   // another tab moved it while we were probing
        return false
      },
    })
    expect(probed).toBe(true)
    expect(vfs).toBe(WASQLiteVFS.OPFSWriteAheadVFS)
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
    expect(h.calls).toEqual(['open', 'sql:PRAGMA user_version', 'close'])
  })

  it('does nothing at all for a CoopSync target', async () => {
    // It resolves to CoopSync only with no sidecars, so there is nothing on
    // disk it cannot read — including a hot journal, which it handles itself.
    const h = harness({[DB]: 4096, [`${DB}-journal`]: 8192})
    await prepareLocalDbForVfs(DB, WASQLiteVFS.OPFSCoopSyncVFS, h.deps)
    expect(h.calls).toEqual([])
  })

  it('refuses to recover a hot journal next to sidecars instead of opening CoopSync', async () => {
    // Both together is a state this design says cannot occur. Recovering would
    // roll the journal into the main file underneath the log — the two measured
    // data-loss shapes in one boot — so the only safe answer is to stop.
    const h = harness({[DB]: 4096, [`${DB}-journal`]: 8192, [`${DB}-wa0`]: 20704})
    await expect(prepareLocalDbForVfs(DB, WASQLiteVFS.OPFSWriteAheadVFS, h.deps))
      .rejects.toBeInstanceOf(LocalDbVfsHandoffError)
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


describe('a refusal carries enough context to offer a backup', () => {
  const sized = (files: Record<string, number>) => ({
    fileSize: async (name: string) => (name in files ? files[name] : null),
  })

  it('classifies a failed write-ahead open on a database that has already moved', async () => {
    const opened = await asLostWriteAheadSupport(
      new Error('NoModificationAllowedError'), DB, WASQLiteVFS.OPFSWriteAheadVFS,
      sized({[DB]: 4096, [`${DB}-wa0`]: 0}),
    )
    expect(opened).toBeInstanceOf(LocalDbVfsHandoffError)
    // The generic screen offers Sign out, which cannot restore this profile.
    expect((opened as Error).message).toContain('this browser profile')
  })

  it('leaves an unrelated open failure alone', async () => {
    const original = new Error('something else entirely')
    expect(await asLostWriteAheadSupport(
      original, DB, WASQLiteVFS.OPFSWriteAheadVFS, sized({[DB]: 4096}),
    )).toBe(original)
    expect(await asLostWriteAheadSupport(
      original, DB, WASQLiteVFS.OPFSCoopSyncVFS, sized({[DB]: 4096, [`${DB}-wa0`]: 0}),
    )).toBe(original)
  })

  it('carries the account so the fallback can export without an open connection', () => {
    const tagged = tagHandoffErrorUserId(new LocalDbVfsHandoffError('nope'), 'user-1')
    expect(handoffErrorUserId(tagged)).toBe('user-1')
    expect(handoffErrorUserId(new Error('unrelated'))).toBeNull()
  })
})
