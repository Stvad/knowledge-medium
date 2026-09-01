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
 * outrank every other input here. Nothing moves a database back, because doing
 * that silently at boot means lifting committed transactions out of a log and
 * hoping — the direction with no safe automatic answer. Moving one back is a
 * deliberate operation, not something a failed probe can trigger.
 *
 * The two VFSes share the main `.db` byte format, so the move is not a data
 * migration. The one thing it needs is `prepareLocalDbForVfs`: the write-ahead
 * VFS never sees a hot rollback journal, so CoopSync has to clear one first.
 * Evidence in `docs/opfs-write-ahead-vfs.md`.
 */

import { WASQLiteOpenFactory, WASQLiteVFS } from '@powersync/web'
import { WRITE_AHEAD_SIDECAR_SUFFIXES } from '@/data/dbFileSiblings.js'
import { isLocalDbCorruptionError } from '@/utils/localDbCorruption.js'

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

  constructor(message: string, options?: {cause?: unknown}) {
    super(message)
    if (options?.cause !== undefined) this.cause = options.cause
  }
}

/**
 * Recognise the handoff error across HMR / bundle boundaries where `instanceof`
 * can fail, the way `corruptErrorUserId` does for the corruption error. The
 * bootstrap fallback branches on this to offer Reload rather than the generic
 * screen's Sign out, which does nothing for a database that is merely busy.
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
  writeAheadSupport ??= runProbeWorker()
  return writeAheadSupport
}

const PROBE_TIMEOUT_MS = 5_000

const runProbeWorker = async (): Promise<boolean> => {
  let worker: Worker
  try {
    worker = new Worker(new URL('./writeAheadVfsProbe.worker.ts', import.meta.url), {type: 'module'})
  } catch (err) {
    // Warned rather than swallowed: a probe that stops resolving in production
    // is indistinguishable from a browser that lacks the feature, and the whole
    // rollout would go quietly inert.
    console.warn('[localDbVfs] write-ahead probe worker could not be started', err)
    return false
  }
  try {
    return await new Promise<boolean>(resolve => {
      const timer = setTimeout(() => {
        console.warn(`[localDbVfs] write-ahead probe timed out after ${PROBE_TIMEOUT_MS}ms`)
        resolve(false)
      }, PROBE_TIMEOUT_MS)
      worker.onmessage = (event: MessageEvent<{supported?: unknown}>) => {
        clearTimeout(timer)
        resolve(event.data?.supported === true)
      }
      worker.onerror = event => {
        clearTimeout(timer)
        console.warn('[localDbVfs] write-ahead probe worker failed to run', event.message)
        resolve(false)
      }
      worker.postMessage('probe')
    })
  } finally {
    worker.terminate()
  }
}

export const resolveLocalDbVfs = async (
  dbFilename: string,
  deps: Pick<LocalDbVfsHandoffDeps, 'fileSize' | 'supportsWriteAhead'> = defaultHandoffDeps,
): Promise<LocalDbVfs> => {
  // Sidecars mean this database already IS a write-ahead database, and that
  // outranks the pin and the probe both. The alternative is opening it with a
  // VFS that reads the main file as an intact, older database — which reports
  // `integrity_check` ok and drops whatever is still in the log. If the browser
  // has genuinely lost the capability the open fails loudly, which is the
  // honest outcome and needs no machinery of its own.
  if (await anyWriteAheadSidecar(dbFilename, deps)) return WASQLiteVFS.OPFSWriteAheadVFS

  const override = readLocalDbVfsOverride()
  if (override) return override

  return (await deps.supportsWriteAhead())
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
  if (journalBytes !== null && journalBytes > 0) {
    await deps.withConnection(dbFilename, WASQLiteVFS.OPFSCoopSyncVFS, async execute => {
      await execute('PRAGMA user_version')
    })
  }
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
    // awaiting it unbounded would swallow the timeout just raised and put the
    // caller back on an endless loading screen. A connection we give up on
    // leaks its worker for the rest of the page's life — the cheaper half.
    let closeTimer: ReturnType<typeof setTimeout> | undefined
    await Promise.race([
      Promise.resolve(db.close())
        .catch(err => {
          console.warn('[localDbVfs] handoff connection failed to close', err)
        })
        // Or every healthy handoff reports an abandonment a few seconds later,
        // burying the ones that really did hang.
        .finally(() => clearTimeout(closeTimer)),
      new Promise<void>(resolve => {
        closeTimer = setTimeout(() => {
          console.warn('[localDbVfs] handoff connection did not close in time; abandoning it')
          resolve()
        }, HANDOFF_CLOSE_TIMEOUT_MS)
      }),
    ])
  }
}

const defaultHandoffDeps: LocalDbVfsHandoffDeps = {
  fileSize: opfsFileSize,
  withConnection: withTemporaryConnection,
  supportsWriteAhead: supportsWriteAheadVfs,
}
