/**
 * Which wa-sqlite VFS opens this device's local SQLite file.
 *
 * `OPFSWriteAheadVFS` (Chromium only — it needs `readwrite-unsafe` access
 * handles) is the only VFS that supports concurrent connections, which is what
 * lets PowerSync open read-only connections alongside the writer instead of
 * serialising every read behind it. Everywhere else we stay on
 * `OPFSCoopSyncVFS`.
 *
 * The choice is ONE-WAY. A database moves to the write-ahead VFS and stays
 * there: its `<db>-wa0` / `<db>-wa1` sidecars are the record of that, and they
 * outrank every other input here. Nothing in this module moves a database back;
 * `docs/opfs-write-ahead-vfs.md` has the manual sequence and why it is manual.
 *
 * The two VFSes share the main `.db` byte format, so the move is not a data
 * migration. The one thing it needs is `prepareLocalDbForVfs`: the write-ahead
 * VFS never sees a hot rollback journal, so CoopSync has to clear one first.
 * Evidence in `docs/opfs-write-ahead-vfs.md`.
 */

import { WASQLiteOpenFactory, WASQLiteVFS } from '@powersync/web'
import { WRITE_AHEAD_SIDECAR_SUFFIXES } from '@/data/dbFileSiblings.js'
import { corruptErrorUserId, isLocalDbCorruptionError } from '@/utils/localDbCorruption.js'

export type LocalDbVfs = WASQLiteVFS.OPFSCoopSyncVFS | WASQLiteVFS.OPFSWriteAheadVFS

/**
 * Pins the VFS for a database that has not moved yet: `coop-sync` to hold a
 * device back, `write-ahead` to opt one in ahead of the probe. Consulted only
 * for databases with no sidecars — see `resolveLocalDbVfs`.
 */
export const LOCAL_DB_VFS_OVERRIDE_KEY = 'km.local-db-vfs'

const OVERRIDE_VALUES: Record<string, LocalDbVfs> = {
  'coop-sync': WASQLiteVFS.OPFSCoopSyncVFS,
  'write-ahead': WASQLiteVFS.OPFSWriteAheadVFS,
}

/** Raised when the database cannot be prepared for the VFS about to open it. */
export class LocalDbVfsHandoffError extends Error {
  override name = 'LocalDbVfsHandoffError'

  /**
   * Set by the caller that knows it. Every refusal here leaves the user unable
   * to open their database, and the only useful thing to offer them is a copy
   * of it — which `downloadLocalDbBackup` needs this to find.
   */
  userId?: string

  constructor(message: string, options?: {cause?: unknown}) {
    super(message)
    if (options?.cause !== undefined) this.cause = options.cause
  }
}

/** Attach the account whose database this refusal is about, for the fallback. */
export const tagHandoffErrorUserId = (error: unknown, userId: string): unknown => {
  if (isLocalDbVfsHandoffError(error) && typeof error === 'object' && error !== null) {
    (error as {userId?: string}).userId = userId
  }
  return error
}

/** The account from a tagged handoff error, or null. Mirrors `corruptErrorUserId`. */
export const handoffErrorUserId = (error: unknown): string | null => {
  if (!isLocalDbVfsHandoffError(error)) return null
  const userId = (error as {userId?: unknown}).userId
  return typeof userId === 'string' && userId.length > 0 ? userId : null
}

/**
 * Recognise the handoff error across HMR / bundle boundaries where `instanceof`
 * can fail, the way `corruptErrorUserId` does for the corruption error.
 */
export const isLocalDbVfsHandoffError = (error: unknown): boolean => {
  if (error instanceof LocalDbVfsHandoffError) return true
  return typeof error === 'object'
    && error !== null
    && (error as {name?: unknown}).name === 'LocalDbVfsHandoffError'
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
 *
 * A failure to answer counts as "no". That is only ever a decision about a
 * database with no sidecars, where the cost is staying on CoopSync for this
 * session and deciding again on the next boot.
 */
export const supportsWriteAheadVfs = (): Promise<boolean> => {
  writeAheadSupport ??= (async () => {
    // One retry, because an inconclusive answer is not the same as "no": acting
    // on it sends this tab to CoopSync while another tab may be moving the very
    // same database. A second attempt converts most transient failures into a
    // real answer; a still-inconclusive one settles as "no", which is only ever
    // a decision about a database that has not moved.
    return (await runProbeWorker()) ?? (await runProbeWorker()) ?? false
  })()
  return writeAheadSupport
}

const PROBE_TIMEOUT_MS = 5_000

const runProbeWorker = async (): Promise<boolean | null> => {
  let worker: Worker
  try {
    worker = new Worker(new URL('./writeAheadVfsProbe.worker.ts', import.meta.url), {type: 'module'})
  } catch (err) {
    // Warned rather than swallowed: a probe that stops resolving in production
    // is indistinguishable from a browser that lacks the feature, and the whole
    // rollout would go quietly inert.
    console.warn('[localDbVfs] write-ahead probe worker could not be started', err)
    return null
  }
  try {
    return await new Promise<boolean | null>(resolve => {
      const timer = setTimeout(() => {
        console.warn(`[localDbVfs] write-ahead probe timed out after ${PROBE_TIMEOUT_MS}ms`)
        resolve(null)
      }, PROBE_TIMEOUT_MS)
      worker.onmessage = (event: MessageEvent<{supported?: unknown}>) => {
        clearTimeout(timer)
        resolve(typeof event.data?.supported === 'boolean' ? event.data.supported : null)
      }
      worker.onerror = event => {
        clearTimeout(timer)
        console.warn('[localDbVfs] write-ahead probe worker failed to run', event.message)
        resolve(null)
      }
      worker.postMessage('probe')
    })
  } finally {
    worker.terminate()
  }
}

/**
 * Marks an error as having come from the VFS OPEN specifically, so
 * `asLostWriteAheadSupport` can tell it apart from a schema or migration
 * failure after the database was already open.
 */
const DB_OPEN_FAILURE = Symbol.for('km.localDbVfs.openFailure')

export const markDbOpenFailure = <T,>(error: T): T => {
  if (typeof error === 'object' && error !== null) {
    (error as Record<symbol, unknown>)[DB_OPEN_FAILURE] = true
  }
  return error
}

/**
 * The signature of an OPFS access handle being refused, which is how a lost
 * `readwrite-unsafe` capability actually surfaces. Matched on text rather than
 * identity because this error has crossed a worker boundary and is typically a
 * plain object by the time it arrives, not a DOMException.
 */
const HANDLE_REFUSAL_NAMES = [
  'NoModificationAllowedError',
  'InvalidStateError',
  'NotAllowedError',
] as const

const looksLikeHandleRefusal = (error: unknown): boolean => {
  if (typeof error !== 'object' || error === null) return false
  const {name, message} = error as {name?: unknown; message?: unknown}
  const text = `${typeof name === 'string' ? name : ''} ${typeof message === 'string' ? message : ''}`
  return HANDLE_REFUSAL_NAMES.some(candidate => text.includes(candidate))
}

const isDbOpenFailure = (error: unknown): boolean =>
  typeof error === 'object' && error !== null && (error as Record<symbol, unknown>)[DB_OPEN_FAILURE] === true

/**
 * Turn a failed open into the handoff refusal when the cause is that this
 * browser can no longer read a database it has already moved. Classified after
 * the fact rather than by pre-checking: a probe here could only answer with the
 * same boolean that already chose the VFS, and a false negative would refuse a
 * database that opens perfectly well.
 */
export const asLostWriteAheadSupport = async (
  error: unknown,
  dbFilename: string,
  vfs: LocalDbVfs,
  deps: Pick<LocalDbVfsHandoffDeps, 'fileSize'> = defaultHandoffDeps,
): Promise<unknown> => {
  if (vfs !== WASQLiteVFS.OPFSWriteAheadVFS) return error
  if (isLocalDbVfsHandoffError(error)) return error
  // Corruption keeps its own classification: it has a recovery flow (Export +
  // Reset) that this one does not, and every database on this path has
  // sidecars, so a blanket wrap would swallow all of them.
  if (isLocalDbCorruptionError(error) || corruptErrorUserId(error) !== null) return error
  // Only a failure to OPEN, and only one that looks like the handle being
  // refused. `powerSyncDb.init()` covers far more than the open — buckets,
  // schema replacement, version loading — and a failure in any of those says
  // nothing about browser support, so the marker alone is too coarse.
  if (!isDbOpenFailure(error) || !looksLikeHandleRefusal(error)) return error
  if (!(await anyWriteAheadSidecar(dbFilename, deps))) return error
  return new LocalDbVfsHandoffError(
    'This browser could not open this device\'s local database. It was last written in a storage mode ' +
    'this browser may no longer support — the data is still here, in this browser profile, and another ' +
    'browser has its own separate storage and cannot reach it. Updating this browser (or re-enabling ' +
    'whatever disabled the feature) should restore access; export a backup below either way.',
    {cause: error},
  )
}

/**
 * The deploy gate for the rollout (`docs/opfs-write-ahead-vfs.md`).
 *
 * TRUE as of Deploy 2: a database with no sidecars is moved to the write-ahead
 * VFS when this browser supports it. Deploy 1 — which reads the record without
 * creating one — shipped ahead of this, so there is a build to roll back TO
 * that handles a moved database correctly.
 *
 * Setting this back to `false` is the safe rollback. Reverting the module along
 * with it is NOT: a build without the sidecar branch opens a moved database
 * with CoopSync, which reads an intact but older file and drops whatever is
 * still in the log.
 */
const MOVE_NEW_DATABASES = true

export const resolveLocalDbVfs = async (
  dbFilename: string,
  deps: Pick<LocalDbVfsHandoffDeps, 'fileSize' | 'supportsWriteAhead'> = defaultHandoffDeps,
): Promise<LocalDbVfs> => {
  // Sidecars mean this database already IS a write-ahead database, and that
  // outranks the pin and the probe both. The alternative is opening it with a
  // VFS that reads the main file as an intact, older database — `integrity_check`
  // ok, and whatever is still in the log dropped. Note this is EXISTENCE, not
  // size: a zero-byte sidecar counts, because the VFS creates both on every open
  // and an interrupted one leaves them empty.
  if (await anyWriteAheadSidecar(dbFilename, deps)) return WASQLiteVFS.OPFSWriteAheadVFS

  const override = readLocalDbVfsOverride()
  // Short-circuits before the probe while the gate is closed, so a build that
  // moves nothing also spawns no probe worker.
  const target = override ?? (MOVE_NEW_DATABASES && await deps.supportsWriteAhead()
    ? WASQLiteVFS.OPFSWriteAheadVFS
    : WASQLiteVFS.OPFSCoopSyncVFS)
  if (target === WASQLiteVFS.OPFSWriteAheadVFS) return target

  // Choosing CoopSync, so look again. The probe above can take seconds (its
  // timeout alone is 5s), and another tab reaching a different answer in that
  // window will have moved this database and created the log. CoopSync over a
  // live log is the one outcome that must never happen, and the check is two
  // stats — cheap enough to pay for a window this wide.
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
  /**
   * Open a throwaway CoopSync connection, run `fn`, then close it. CoopSync by
   * definition: the only thing this is for is letting it honour a hot journal.
   */
  withConnection: (
    dbFilename: string,
    fn: (execute: (sql: string) => Promise<unknown>) => Promise<void>,
  ) => Promise<void>
  supportsWriteAhead: () => Promise<boolean>
}

/**
 * Bring the on-disk state in line with the VFS that is about to open it. Call
 * before the first connection of the session; a no-op in the steady state.
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
    // A corrupt database can surface from the recovery open. Rewrapping it
    // would cost the user the recovery that exists for it: the bootstrap
    // boundary classifies this error, captures forensics, and offers Export +
    // Reset. Reload — all this wrapper's message can offer — just repeats the
    // same failing handoff.
    if (isLocalDbCorruptionError(err)) throw err
    // Anything else is an OPFS DOMException or a failed open. Untranslated it
    // blocks boot with jargon in a <pre>; the cause is the one named here.
    throw new LocalDbVfsHandoffError(
      'Could not prepare this device\'s local database for this browser\'s storage mode. Another tab of ' +
      'the app may still be holding it — close the other tabs and reload.',
      {cause: err},
    )
  }
}

const runHandoff = async (
  dbFilename: string,
  target: LocalDbVfs,
  deps: LocalDbVfsHandoffDeps,
): Promise<void> => {
  // CoopSync needs no preparation: a database resolves to it only when it has
  // no sidecars, so there is nothing on disk it cannot read.
  if (target !== WASQLiteVFS.OPFSWriteAheadVFS) return

  // `OPFSWriteAheadVFS`'s xAccess only reports files it already has open, so
  // SQLite never learns about a hot rollback journal and opens a database that
  // still needs rolling back. `OPFSCoopSyncVFS` does honour it: one open/close
  // there performs the recovery. A zero-byte journal is the normal residue of a
  // clean CoopSync close and means nothing.
  const journalBytes = await deps.fileSize(`${dbFilename}-journal`)
  if (journalBytes === null || journalBytes === 0) return

  // ...but that recovery is a CoopSync open, and CoopSync must never touch a
  // database that has sidecars. This module's own invariant says the pair
  // cannot co-occur — the write-ahead VFS routes `<db>-journal` to a pooled
  // temp file and never writes that name — so reaching here means something
  // outside this code already opened a write-ahead database with CoopSync.
  // Recovering now would roll the journal into the main file UNDERNEATH the
  // log: both measured data-loss shapes in one boot. Refuse instead.
  if (await anyWriteAheadSidecar(dbFilename, deps)) {
    throw new LocalDbVfsHandoffError(
      'This device\'s local database is in a state this app cannot safely open: it carries both a ' +
      'write-ahead log and an unfinished rollback journal. Export a backup before doing anything ' +
      'else, and do not open it in an older version of the app.',
    )
  }

  await deps.withConnection(dbFilename, async execute => {
    await execute('PRAGMA user_version')
  })
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

/**
 * Opening this connection can block indefinitely when another context holds the
 * database. Unbounded, that is a worse outcome than any refusal: it happens
 * before the error boundary exists, so the user gets a loading screen with no
 * message and no button, forever.
 */
const HANDOFF_CONNECTION_TIMEOUT_MS = 15_000
const HANDOFF_CLOSE_TIMEOUT_MS = 3_000

const withTemporaryConnection: LocalDbVfsHandoffDeps['withConnection'] = async (dbFilename, fn) => {
  const db = new WASQLiteOpenFactory({
    dbFilename,
    vfs: WASQLiteVFS.OPFSCoopSyncVFS,
    flags: {enableMultiTabs: true},
  }).openDB()

  let bodyError: unknown = null
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
  } catch (err) {
    bodyError = err
  } finally {
    clearTimeout(timer)
  }

  // Bounded, because close() waits on the SAME lock the open was stuck on:
  // unbounded it would swallow whatever we are already reporting and put the
  // caller back on an endless loading screen.
  const closed = await closeWithin(db, HANDOFF_CLOSE_TIMEOUT_MS)

  if (bodyError) throw bodyError
  // A connection that did not close still holds an EXCLUSIVE OPFS handle, and
  // the whole point of this one is that the caller opens the same file next —
  // `readwrite-unsafe`, which cannot coexist with it. Proceeding would fail
  // that open with a raw DOMException on the generic error screen. Only a
  // reload frees the worker, which is exactly what this error asks for.
  if (!closed) {
    throw new LocalDbVfsHandoffError(
      'This device\'s local database is still held by a previous connection. Reload the app; if it ' +
      'persists, close the other tabs first.',
    )
  }
}

const closeWithin = async (db: {close(): void | Promise<void>}, ms: number): Promise<boolean> => {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      Promise.resolve(db.close()).then(() => true, err => {
        console.warn('[localDbVfs] handoff connection failed to close', err)
        return false
      }),
      new Promise<boolean>(resolve => {
        timer = setTimeout(() => {
          console.warn('[localDbVfs] handoff connection did not close in time')
          resolve(false)
        }, ms)
      }),
    ])
  } finally {
    // Or a healthy close leaves a timer that fires a false alarm seconds later,
    // burying the ones that really did hang.
    clearTimeout(timer)
  }
}

const defaultHandoffDeps: LocalDbVfsHandoffDeps = {
  fileSize: opfsFileSize,
  withConnection: withTemporaryConnection,
  supportsWriteAhead: supportsWriteAheadVfs,
}
