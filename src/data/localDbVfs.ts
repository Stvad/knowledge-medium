/**
 * Which wa-sqlite VFS opens this device's local SQLite file, and the handoff
 * that has to run when that answer changes between sessions.
 *
 * `OPFSWriteAheadVFS` (Chromium only — it needs `readwrite-unsafe` access
 * handles) is the only VFS that supports concurrent connections, which is what
 * lets PowerSync open read-only connections alongside the writer instead of
 * serialising every read behind it. Everywhere else we stay on
 * `OPFSCoopSyncVFS`.
 *
 * The two VFSes share the main `.db` byte format — either can open a file the
 * other created — so switching is not a data migration. What is NOT shared is
 * the state OUTSIDE that file: `OPFSWriteAheadVFS` keeps its own write-ahead
 * log in `<db>-wa0` / `<db>-wa1` sidecars, and `OPFSCoopSyncVFS` relies on
 * SQLite's rollback journal. Both directions of the switch therefore have a
 * silent-data-loss failure mode, and `prepareLocalDbForVfs` is what closes
 * them. Measured on Chrome 148 (2026-08-31), including `PRAGMA
 * integrity_check` reporting `ok` in both failure modes.
 */

import { WASQLiteOpenFactory, WASQLiteVFS } from '@powersync/web'

export type LocalDbVfs = WASQLiteVFS.OPFSCoopSyncVFS | WASQLiteVFS.OPFSWriteAheadVFS

/** `OPFSWriteAheadVFS`'s write-ahead log — two files, alternated WAL2-style. */
export const WRITE_AHEAD_SIDECAR_SUFFIXES = ['-wa0', '-wa1'] as const

/**
 * Pins the VFS for this origin, bypassing the capability probe: `coop-sync` or
 * `write-ahead`. Exists so the write-ahead rollout can be reverted (and A/B
 * measured) without a deploy — `coop-sync` still routes through the full
 * downgrade handoff, so pinning it is safe, not a data-loss switch.
 */
export const LOCAL_DB_VFS_OVERRIDE_KEY = 'km.local-db-vfs'

const OVERRIDE_VALUES: Record<string, LocalDbVfs> = {
  'coop-sync': WASQLiteVFS.OPFSCoopSyncVFS,
  'write-ahead': WASQLiteVFS.OPFSWriteAheadVFS,
}

/**
 * Raised when the local DB carries write-ahead sidecars that this session
 * cannot checkpoint — the one case where opening with `OPFSCoopSyncVFS` would
 * silently drop committed transactions. Surfaces to the user instead.
 */
export class LocalDbVfsHandoffError extends Error {
  override name = 'LocalDbVfsHandoffError'

  constructor(message: string, options?: {cause?: unknown}) {
    super(message)
    if (options?.cause !== undefined) this.cause = options.cause
  }
}

export const readLocalDbVfsOverride = (): LocalDbVfs | null => {
  try {
    const raw = globalThis.localStorage?.getItem(LOCAL_DB_VFS_OVERRIDE_KEY)
    return raw ? OVERRIDE_VALUES[raw] ?? null : null
  } catch {
    return null
  }
}

let writeAheadSupport: Promise<boolean> | null = null

/**
 * Whether this browser can hold two concurrent sync access handles on one OPFS
 * file. Runs in a dedicated worker (see the probe module) and is cached for the
 * page's lifetime, not persisted — a stale "supported" written by a previous
 * browser version would pick a VFS that cannot open.
 */
export const supportsWriteAheadVfs = (): Promise<boolean> => {
  writeAheadSupport ??= runProbeWorker()
  return writeAheadSupport
}

const PROBE_TIMEOUT_MS = 5_000

const runProbeWorker = async (): Promise<boolean> => {
  let worker: Worker
  try {
    worker = new Worker(new URL('./writeAheadVfsProbe.worker.ts', import.meta.url), {type: 'module'})
  } catch {
    return false
  }
  try {
    return await new Promise<boolean>(resolve => {
      // A probe that never answers means we don't know, and "don't know" has to
      // resolve to the VFS that works everywhere.
      const timer = setTimeout(() => resolve(false), PROBE_TIMEOUT_MS)
      worker.onmessage = (event: MessageEvent<{supported?: unknown}>) => {
        clearTimeout(timer)
        resolve(event.data?.supported === true)
      }
      worker.onerror = () => {
        clearTimeout(timer)
        resolve(false)
      }
      worker.postMessage('probe')
    })
  } finally {
    worker.terminate()
  }
}

export const resolveLocalDbVfs = async (): Promise<LocalDbVfs> => {
  const override = readLocalDbVfsOverride()
  if (override) return override
  return (await supportsWriteAheadVfs())
    ? WASQLiteVFS.OPFSWriteAheadVFS
    : WASQLiteVFS.OPFSCoopSyncVFS
}

export interface LocalDbVfsHandoffDeps {
  /** Size in bytes, or null when the file does not exist. */
  fileSize: (name: string) => Promise<number | null>
  removeFile: (name: string) => Promise<void>
  /** Open a throwaway connection with `vfs`, run `fn`, then close it. */
  withConnection: (
    dbFilename: string,
    vfs: LocalDbVfs,
    fn: (execute: (sql: string) => Promise<unknown>) => Promise<void>,
  ) => Promise<void>
  supportsWriteAhead: () => Promise<boolean>
}

/**
 * Bring the on-disk state in line with the VFS that is about to open it. Call
 * before the first connection of the session; a no-op in the steady state
 * (same VFS as last time, clean shutdown).
 */
export const prepareLocalDbForVfs = async (
  dbFilename: string,
  target: LocalDbVfs,
  deps: LocalDbVfsHandoffDeps = defaultHandoffDeps,
): Promise<void> => {
  if (target === WASQLiteVFS.OPFSWriteAheadVFS) {
    // `OPFSWriteAheadVFS`'s xAccess only reports files it already has open, so
    // SQLite never learns about a hot rollback journal and opens a database
    // that still needs rolling back. `OPFSCoopSyncVFS` does honour it: one
    // open/close there performs the recovery.
    const journalBytes = await deps.fileSize(`${dbFilename}-journal`)
    if (journalBytes !== null && journalBytes > 0) {
      await deps.withConnection(dbFilename, WASQLiteVFS.OPFSCoopSyncVFS, async execute => {
        await execute('PRAGMA user_version')
      })
    }
    return
  }

  const sidecars: string[] = []
  for (const suffix of WRITE_AHEAD_SIDECAR_SUFFIXES) {
    const name = `${dbFilename}${suffix}`
    if ((await deps.fileSize(name)) !== null) sidecars.push(name)
  }
  if (sidecars.length === 0) return

  if (!(await deps.supportsWriteAhead())) {
    throw new LocalDbVfsHandoffError(
      'This device\'s local database was last used with a storage mode this browser no longer supports, ' +
      'and it holds changes that only that mode can read. Open the app in a Chromium-based browser once ' +
      'so the pending changes can be written back, or restore from a backup.',
    )
  }

  // Committed transactions can live only in the sidecars — the main file reads
  // as an intact, older database, so skipping this loses them with no error.
  await deps.withConnection(dbFilename, WASQLiteVFS.OPFSWriteAheadVFS, async execute => {
    await execute('PRAGMA wal_checkpoint=truncate')
  })

  // Deleting them is equally load-bearing: a checkpoint does not empty the
  // files, so a later switch back would replay that stale log OVER whatever
  // `OPFSCoopSyncVFS` wrote in the meantime and drop those writes instead.
  for (const name of sidecars) await deps.removeFile(name)
}

const opfsFileSize = async (name: string): Promise<number | null> => {
  try {
    const root = await navigator.storage.getDirectory()
    const handle = await root.getFileHandle(name)
    return (await handle.getFile()).size
  } catch (err) {
    if (err instanceof DOMException && err.name === 'NotFoundError') return null
    throw err
  }
}

const opfsRemoveFile = async (name: string): Promise<void> => {
  const root = await navigator.storage.getDirectory()
  try {
    await root.removeEntry(name)
  } catch (err) {
    if (err instanceof DOMException && err.name === 'NotFoundError') return
    throw err
  }
}

const withTemporaryConnection: LocalDbVfsHandoffDeps['withConnection'] = async (
  dbFilename,
  vfs,
  fn,
) => {
  const db = new WASQLiteOpenFactory({dbFilename, vfs, flags: {enableMultiTabs: true}}).openDB()
  try {
    await fn(sql => db.execute(sql))
  } finally {
    await db.close()
  }
}

const defaultHandoffDeps: LocalDbVfsHandoffDeps = {
  fileSize: opfsFileSize,
  removeFile: opfsRemoveFile,
  withConnection: withTemporaryConnection,
  supportsWriteAhead: supportsWriteAheadVfs,
}
