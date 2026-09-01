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
 * silent-data-loss failure mode — neither of which `PRAGMA integrity_check`
 * reports — and `prepareLocalDbForVfs` is what closes them. The evidence is in
 * `docs/opfs-write-ahead-vfs.md`.
 */

import { WASQLiteOpenFactory, WASQLiteVFS } from '@powersync/web'
import { WRITE_AHEAD_SIDECAR_SUFFIXES } from '@/data/dbFileSiblings.js'
import { isLocalDbCorruptionError } from '@/utils/localDbCorruption.js'

export type LocalDbVfs = WASQLiteVFS.OPFSCoopSyncVFS | WASQLiteVFS.OPFSWriteAheadVFS

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

  /**
   * Whether pinning the compatibility VFS could get past this. FALSE when
   * CoopSync is already the target that failed — offering it there reloads into
   * the identical refusal and leaves a pin behind that helps nothing.
   */
  readonly compatibilityModeHelps: boolean

  constructor(message: string, options?: {cause?: unknown; compatibilityModeHelps?: boolean}) {
    super(message)
    this.compatibilityModeHelps = options?.compatibilityModeHelps ?? false
    if (options?.cause !== undefined) this.cause = options.cause
  }
}

/** Reads the flag off an error that may have crossed a bundle boundary. */
export const handoffCompatibilityModeHelps = (error: unknown): boolean =>
  typeof error === 'object'
  && error !== null
  && (error as {compatibilityModeHelps?: unknown}).compatibilityModeHelps === true

/**
 * Recognise the handoff error across HMR / bundle boundaries where `instanceof`
 * can fail, the way `corruptErrorUserId` does for the corruption error. The
 * bootstrap fallback branches on this to offer actions that fit — the generic
 * one offers Sign out, which does nothing for either cause.
 */
export const isLocalDbVfsHandoffError = (error: unknown): boolean => {
  if (error instanceof LocalDbVfsHandoffError) return true
  return typeof error === 'object'
    && error !== null
    && (error as {name?: unknown}).name === 'LocalDbVfsHandoffError'
}

/**
 * Pin the compatibility VFS for this device, for the bootstrap fallback's escape
 * hatch. Returns whether it stuck: storage can throw (private mode, a storage
 * policy), and the reader already treats that as normal — a recovery button
 * that throws out of its own click handler would just be inert.
 */
export const pinCoopSyncVfs = (): boolean => {
  try {
    globalThis.localStorage?.setItem(LOCAL_DB_VFS_OVERRIDE_KEY, 'coop-sync')
    return true
  } catch {
    return false
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

/**
 * `unknown` is NOT a synonym for `unsupported`, and conflating them costs a
 * boot: a device that really does support the write-ahead VFS, whose probe
 * merely failed to run (worker fetch offline, timeout under load), would be
 * routed to CoopSync — and the downgrade then refuses, because it cannot
 * checkpoint the sidecars it finds, leaving the app unable to open at all.
 */
export type WriteAheadSupport = 'supported' | 'unsupported' | 'unknown'

let writeAheadSupport: Promise<WriteAheadSupport> | null = null

/**
 * Whether this browser can hold two concurrent sync access handles on one OPFS
 * file. Runs in a dedicated worker (see the probe module) and is cached for the
 * page's lifetime, not persisted — a stale "supported" written by a previous
 * browser version would pick a VFS that cannot open.
 */
export const writeAheadVfsSupport = (): Promise<WriteAheadSupport> => {
  writeAheadSupport ??= runProbeWorker()
  return writeAheadSupport
}

const PROBE_TIMEOUT_MS = 5_000

const runProbeWorker = async (): Promise<WriteAheadSupport> => {
  let worker: Worker
  try {
    worker = new Worker(new URL('./writeAheadVfsProbe.worker.ts', import.meta.url), {type: 'module'})
  } catch (err) {
    // Distinct warnings on each inconclusive path: without them a probe that
    // stops resolving in production is indistinguishable from a browser that
    // genuinely lacks the feature, and the whole rollout is silently inert.
    console.warn('[localDbVfs] write-ahead probe worker could not be started', err)
    return 'unknown'
  }
  try {
    return await new Promise<WriteAheadSupport>(resolve => {
      const timer = setTimeout(() => {
        console.warn(`[localDbVfs] write-ahead probe timed out after ${PROBE_TIMEOUT_MS}ms`)
        resolve('unknown')
      }, PROBE_TIMEOUT_MS)
      worker.onmessage = (event: MessageEvent<{supported?: unknown}>) => {
        clearTimeout(timer)
        // The worker answers `false` only when the handles were actually
        // refused; anything else reaching us is a probe that did not run.
        resolve(typeof event.data?.supported === 'boolean'
          ? (event.data.supported ? 'supported' : 'unsupported')
          : 'unknown')
      }
      worker.onerror = event => {
        clearTimeout(timer)
        console.warn('[localDbVfs] write-ahead probe worker failed to run', event.message)
        resolve('unknown')
      }
      worker.postMessage('probe')
    })
  } finally {
    worker.terminate()
  }
}

export const resolveLocalDbVfs = async (
  dbFilename: string,
  deps: Pick<LocalDbVfsHandoffDeps, 'fileSize' | 'writeAheadSupport'> = defaultHandoffDeps,
): Promise<LocalDbVfs> => {
  const override = readLocalDbVfsOverride()
  if (override) return override

  const support = await deps.writeAheadSupport()
  if (support === 'supported') return WASQLiteVFS.OPFSWriteAheadVFS
  if (support === 'unsupported') return WASQLiteVFS.OPFSCoopSyncVFS

  // Inconclusive. Sidecars on disk are proof this device ran the write-ahead
  // VFS before, so staying on it is the option that cannot lose data: the
  // alternative is a downgrade this session has no way to carry out.
  return (await anyWriteAheadSidecar(dbFilename, deps))
    ? WASQLiteVFS.OPFSWriteAheadVFS
    : WASQLiteVFS.OPFSCoopSyncVFS
}

const anyWriteAheadSidecar = async (
  dbFilename: string,
  deps: Pick<LocalDbVfsHandoffDeps, 'fileSize'>,
): Promise<boolean> => {
  const sizes = await Promise.all(
    WRITE_AHEAD_SIDECAR_SUFFIXES.map(suffix => deps.fileSize(`${dbFilename}${suffix}`)),
  )
  return sizes.some(size => size !== null)
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
  writeAheadSupport: () => Promise<WriteAheadSupport>
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
  try {
    await runHandoff(dbFilename, target, deps)
  } catch (err) {
    if (isLocalDbVfsHandoffError(err)) throw err
    // A corrupt database can surface from the temporary open or the checkpoint.
    // Rewrapping it would cost the user the recovery that exists for it: the
    // bootstrap boundary classifies this error, captures forensics, and offers
    // Export + Reset. Reload — all this wrapper's message can offer — just
    // repeats the same failing handoff.
    if (isLocalDbCorruptionError(err)) throw err
    // Anything else here is an OPFS DOMException or a failed open. Untranslated
    // it blocks boot with jargon in a <pre>; the causes are the same ones the
    // typed message already names.
    throw new LocalDbVfsHandoffError(
      'Could not prepare this device\'s local database for this browser\'s storage mode. Another tab of ' +
      'the app may still be holding it — close the other tabs and reload.',
      {cause: err, compatibilityModeHelps: target === WASQLiteVFS.OPFSWriteAheadVFS},
    )
  }
}

const runHandoff = async (
  dbFilename: string,
  target: LocalDbVfs,
  deps: LocalDbVfsHandoffDeps,
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

  if (!(await anyWriteAheadSidecar(dbFilename, deps))) return

  if ((await deps.writeAheadSupport()) !== 'supported') {
    throw new LocalDbVfsHandoffError(
      'This browser can no longer read part of its local database: the pending changes are in a storage ' +
      'mode it has stopped supporting. They are still on this device, in this browser profile — another ' +
      'browser has its own separate storage and cannot reach them. Updating this browser (or re-enabling ' +
      'whatever disabled the feature) and reopening the app will recover them; otherwise restore from a backup.',
    )
  }

  // Committed transactions can live only in the sidecars — the main file reads
  // as an intact, older database, so skipping this loses them with no error.
  // The checkpoint can also come back PARTIAL (another connection pinned an
  // older read point) without failing the statement, so the drain is confirmed
  // rather than assumed: `wal_checkpoint=noop` reports what is still in the log.
  let remaining: unknown
  await deps.withConnection(dbFilename, WASQLiteVFS.OPFSWriteAheadVFS, async execute => {
    await execute('PRAGMA wal_checkpoint=truncate')
    remaining = await execute('PRAGMA wal_checkpoint=noop')
  })
  if (walPagesRemaining(remaining) !== 0) {
    throw new LocalDbVfsHandoffError(
      'Could not write this device\'s pending local changes back into the main database file — another ' +
      'tab of the app is probably still holding it. Close the other tabs and reload.',
    )
  }

  // Deleting them is equally load-bearing: a checkpoint does not empty the
  // files, so a later switch back would replay that stale log OVER whatever
  // `OPFSCoopSyncVFS` wrote in the meantime and drop those writes instead.
  // Both names, not the pre-open inventory: opening the connection above
  // CREATES whichever of the pair was missing.
  //
  // Nothing holds a cross-tab lock across this loop. It does not need one: OPFS
  // refuses to remove a file another context still has open, so a second tab on
  // the write-ahead VFS makes this throw rather than discard its log. Accepted
  // residual: that tab could commit and then close between the check above and
  // this loop, and lose those frames — it needs a downgrade (a pinned override
  // or lost capability) racing a closing tab inside one boot, and closing the
  // window costs a worker-held exclusive handle and a protocol to go with it.
  try {
    for (const suffix of WRITE_AHEAD_SIDECAR_SUFFIXES) {
      await deps.removeFile(`${dbFilename}${suffix}`)
    }
  } catch (err) {
    if (err instanceof DOMException && err.name === 'NoModificationAllowedError') {
      throw new LocalDbVfsHandoffError(
        'Another tab of the app is still using this device\'s local database, so its pending changes ' +
        'could not be filed away. Close the other tabs and reload.',
        {cause: err},
      )
    }
    throw err
  }
}

/**
 * Pages still in the write-ahead log, per `PRAGMA wal_checkpoint`. The VFS
 * answers with a single cell whose column name IS the value, so this reads
 * positionally. Returns `null` when the shape isn't recognised — the caller
 * treats that as "not proven empty", because the alternative to a loud refusal
 * here is deleting a log that still holds commits.
 */
const walPagesRemaining = (result: unknown): number | null => {
  const rows = (result as {rows?: {_array?: unknown[]}} | undefined)?.rows?._array
  const row = Array.isArray(rows) ? rows[0] : undefined
  if (!row || typeof row !== 'object') return null
  const [value] = Object.values(row as Record<string, unknown>)
  const pages = Number(value)
  return Number.isFinite(pages) ? pages : null
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

/**
 * Opening this connection can block indefinitely when another context holds the
 * database. Unbounded, that is a worse outcome than any refusal: it happens
 * before the error boundary exists, so the user gets a loading screen with no
 * message and no button, forever. A bounded wait at least reaches a fallback
 * that tells them to close the other tab.
 */
const HANDOFF_CONNECTION_TIMEOUT_MS = 15_000
const HANDOFF_CLOSE_TIMEOUT_MS = 3_000

const withTemporaryConnection: LocalDbVfsHandoffDeps['withConnection'] = async (
  dbFilename,
  vfs,
  fn,
) => {
  const db = new WASQLiteOpenFactory({dbFilename, vfs, flags: {enableMultiTabs: true}}).openDB()
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    await Promise.race([
      fn(sql => db.execute(sql)),
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new LocalDbVfsHandoffError(
            'Timed out waiting for this device\'s local database. Another tab of the app is probably ' +
            'still holding it — close the other tabs and reload.',
          )),
          HANDOFF_CONNECTION_TIMEOUT_MS,
        )
      }),
    ])
  } finally {
    clearTimeout(timer)
    // Bounded, because close() waits on the SAME lock the open was stuck on:
    // awaiting it unbounded here would swallow the timeout we just raised and
    // put the caller right back on an endless loading screen. A connection we
    // give up on leaks its worker for the rest of the page's life, which is the
    // cheaper half of that trade — the page is on its way to an error screen.
    await Promise.race([
      Promise.resolve(db.close()).catch(err => {
        console.warn('[localDbVfs] handoff connection failed to close', err)
      }),
      new Promise<void>(resolve => setTimeout(() => {
        console.warn('[localDbVfs] handoff connection did not close in time; abandoning it')
        resolve()
      }, HANDOFF_CLOSE_TIMEOUT_MS)),
    ])
  }
}

const defaultHandoffDeps: LocalDbVfsHandoffDeps = {
  fileSize: opfsFileSize,
  removeFile: opfsRemoveFile,
  withConnection: withTemporaryConnection,
  writeAheadSupport: writeAheadVfsSupport,
}
