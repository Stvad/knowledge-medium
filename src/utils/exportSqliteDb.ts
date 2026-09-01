/**
 * Download / replace a raw `.db` image for the current user's
 * PowerSync SQLite database.
 *
 * With OPFSCoopSyncVFS the database is a real file at OPFS root. Export
 * must not hand that live file directly to the browser download stack:
 * on large databases the app/sync writer can change the file while
 * Chrome is still reading it. The reliable path is to hold PowerSync's
 * adapter lock while streaming the current .db image to either a user
 * chosen file (Chrome File System Access API) or an OPFS temp snapshot.
 *
 * Import validates a tiny header first, streams the selected file into
 * OPFS staging while the live DB is still intact, then closes PowerSync
 * and replaces the current user's .db from that staging file.
 */

import { v4 as uuidv4 } from 'uuid'
import { Zip, ZipPassThrough } from 'fflate'
import type { Repo } from '../data/repo'
import { dbFilenameForUser } from '@/data/localDbStorage'
import {
  DB_FILE_SIBLING_SUFFIXES,
  SQLITE_JOURNAL_SUFFIXES,
  WRITE_AHEAD_SIDECAR_SUFFIXES,
} from '@/data/dbFileSiblings.js'

export interface RawSqliteDbBlobExport {
  blob: Blob
  filename: string
  cleanup?: () => Promise<void>
}

export interface RawSqliteDbBackup extends RawSqliteDbBlobExport {
  /** OPFS names of the files included in the backup (the `.db`, plus any
   *  crash-recovery siblings). One entry → a plain `.db`; more → a `.zip`. */
  contents: string[]
}

export interface RawSqliteDbFileExport {
  filename: string
  size: number
}

interface PowerSyncWriteLockDb {
  writeLock<T>(callback: (tx: {execute(sql: string): Promise<unknown>}) => Promise<T>): Promise<T>
}

interface SaveFilePickerOptions {
  suggestedName?: string
  types?: Array<{
    description?: string
    accept: Record<string, string[]>
  }>
}

type WindowWithSaveFilePicker = typeof globalThis & {
  showSaveFilePicker?: (options?: SaveFilePickerOptions) => Promise<FileSystemFileHandle>
}

export function rawSqliteDbExportFilenameForUser(userId: string, now = Date.now()): string {
  const dbFilename = dbFilenameForUser(userId)
  return `${dbFilename.replace(/\.db$/, '')}-export-${now}.db`
}

export function rawSqliteDbRecoveryZipFilenameForUser(userId: string, now = Date.now()): string {
  const dbFilename = dbFilenameForUser(userId)
  return `${dbFilename.replace(/\.db$/, '')}-recovery-${now}.zip`
}

export function rawSqliteDbExportFilename(repo: Repo, now = Date.now()): string {
  return rawSqliteDbExportFilenameForUser(repo.user.id, now)
}

export async function chooseRawSqliteExportFile(
  filename: string,
): Promise<FileSystemFileHandle | undefined> {
  const picker = (globalThis as WindowWithSaveFilePicker).showSaveFilePicker
  if (!picker) return undefined
  return picker({
    suggestedName: filename,
    types: [{
      description: 'SQLite database',
      accept: {
        'application/vnd.sqlite3': ['.db', '.sqlite', '.sqlite3'],
        'application/octet-stream': ['.db'],
      },
    }],
  })
}

export async function exportRawSqliteDbToFile(
  repo: Repo,
  destinationHandle: FileSystemFileHandle,
): Promise<RawSqliteDbFileExport> {
  const userId = repo.user.id
  const dbFilename = dbFilenameForUser(userId)
  const filename = destinationHandle.name || rawSqliteDbExportFilename(repo)

  const root = await navigator.storage.getDirectory()
  const fileHandle = await root.getFileHandle(dbFilename)
  const size = await withCheckpointedDbLock(repo, async () => {
    const sourceFile = await fileHandle.getFile()
    await pipeBlobToFileHandle(sourceFile, destinationHandle)
    return sourceFile.size
  })

  return {filename, size}
}

export async function exportRawSqliteDb(repo: Repo): Promise<RawSqliteDbBlobExport> {
  const userId = repo.user.id
  const dbFilename = dbFilenameForUser(userId)
  const filename = rawSqliteDbExportFilename(repo)
  const snapshotName = tempOpfsFilename(dbFilename, 'export-snapshot')

  const root = await navigator.storage.getDirectory()
  const sourceHandle = await root.getFileHandle(dbFilename)
  const sourceFile = await sourceHandle.getFile()

  // This fallback path writes a full second copy of the .db into OPFS (a stable
  // snapshot we can keep reading after the read lock is released). On a large DB
  // that easily exceeds the origin storage quota. Fail fast with the actual
  // sizes instead of letting a bare QuotaExceededError surface from deep inside
  // the stream pipe — that's the failure seen exporting a multi-GB DB in
  // Firefox, which has no showSaveFilePicker and so always lands here.
  const freeBytes = await estimateFreeOpfsBytes()
  if (freeBytes !== undefined && freeBytes < sourceFile.size) {
    throw new Error(insufficientOpfsSpaceMessage(sourceFile.size, freeBytes))
  }

  const snapshotHandle = await root.getFileHandle(snapshotName, {create: true})
  try {
    await withCheckpointedDbLock(repo, async () => {
      // A FRESH handle: `sourceFile` above predates the checkpoint, so piping it
      // would copy the file as it stood before the sidecars were folded in.
      await pipeBlobToFileHandle(await sourceHandle.getFile(), snapshotHandle)
    })
  } catch (err) {
    // Drop the empty/partial snapshot so repeated failures don't accumulate.
    await removeEntryIfExists(root, snapshotName)
    if (err instanceof DOMException && err.name === 'QuotaExceededError') {
      throw new Error(insufficientOpfsSpaceMessage(sourceFile.size, await estimateFreeOpfsBytes()), {cause: err})
    }
    throw err
  }

  const blob = await snapshotHandle.getFile()
  return {
    blob,
    filename,
    cleanup: () => removeEntryIfExists(root, snapshotName),
  }
}

/**
 * Build the recovery backup (the corrupt bytes included), WITHOUT a PowerSync
 * read lock — use only on the corruption path, where the caller already released
 * the connection (`closePowerSyncDbIfOpen`) so nothing holds the OPFS handle. For
 * a live DB use `exportRawSqliteDb`, which snapshots under the adapter lock.
 *
 * Includes the raw `.db` PLUS any crash-recovery siblings that have bytes
 * (`-journal` hot rollback journal / `-wal` / `-shm`). The reset path deletes
 * those siblings, and a hot journal can be exactly what SQLite needs to roll a
 * corrupt DB back to a recoverable state — so dropping them from the backup
 * would leave the user's retained copy unrecoverable in that case. We weigh the
 * `.db` and the siblings TOGETHER: a 0-byte `.db` next to a non-empty journal
 * must still back up the journal, not reject as "nothing to back up".
 *
 * Single non-empty file (`.db` alone — incl. the original iPad incident) → a
 * plain `.db` the user can hand straight to `sqlite3 .recover`, no unzip step.
 * More than one → bundle the fileset into one `.zip` (a single download is the
 * only reliable way to deliver multiple files on iOS), keeping the original OPFS
 * names so SQLite re-pairs the journal on extract. Rejects only when there is
 * genuinely nothing with bytes anywhere.
 */
export async function getRawSqliteDbBackup(userId: string): Promise<RawSqliteDbBackup> {
  const dbFilename = dbFilenameForUser(userId)
  const root = await navigator.storage.getDirectory()

  const dbFile = await readOpfsFileIfExists(root, dbFilename)
  const dbEntry = dbFile && dbFile.size > 0 ? { name: dbFilename, file: dbFile } : null

  const siblings: Array<{ name: string; file: File }> = []
  for (const suffix of DB_FILE_SIBLING_SUFFIXES) {
    const name = dbFilename + suffix
    const file = await readOpfsFileIfExists(root, name)
    if (file && file.size > 0) siblings.push({ name, file })
  }

  // A zero-byte "backup" is not a backup — but only reject if NOTHING (the `.db`
  // and every sibling) has bytes, so the recovery UI can warn instead of
  // reporting a false success.
  if (!dbEntry && siblings.length === 0) {
    throw new Error('The local database files are empty — there is nothing to back up.')
  }

  // Just the `.db` → plain download, no unzip step.
  if (dbEntry && siblings.length === 0) {
    return {
      blob: dbEntry.file,
      filename: rawSqliteDbExportFilenameForUser(userId),
      contents: [dbEntry.name],
    }
  }

  const entries = [...(dbEntry ? [dbEntry] : []), ...siblings]
  // Stored (uncompressed) zip ≈ the sum of the inputs; fail fast with sizes
  // rather than a bare QuotaExceededError mid-stream.
  const totalBytes = entries.reduce((sum, e) => sum + e.file.size, 0)
  const freeBytes = await estimateFreeOpfsBytes()
  if (freeBytes !== undefined && freeBytes < totalBytes) {
    throw new Error(insufficientOpfsSpaceMessage(totalBytes, freeBytes))
  }

  const tempName = tempOpfsFilename(dbFilename, 'recovery-zip')
  const tempHandle = await streamStoredZipToOpfs(root, entries, tempName)
  return {
    blob: await tempHandle.getFile(),
    filename: rawSqliteDbRecoveryZipFilenameForUser(userId),
    cleanup: () => removeEntryIfExists(root, tempName),
    contents: entries.map(e => e.name),
  }
}

/**
 * Delete the user's local SQLite files from OPFS — the `.db` plus its
 * `-journal` / `-wal` / `-shm` siblings. Leaves everything else intact:
 * IndexedDB (e2ee workspace keys), the auth session, and the OPFS `assets/`
 * media tree. The OPFSCoopSyncVFS `.ahp-*` access-handle pools are left for the
 * next VFS init to reclaim (its initialize step drops stale pools whose lock is
 * free), so a fresh PowerSync init re-creates an empty DB and re-syncs.
 *
 * The caller MUST close the PowerSync connection first (release the OPFS sync
 * access handle) — otherwise `removeEntry` can throw on the locked `.db`.
 *
 * Deletes the journal/WAL siblings BEFORE the main `.db`, and if any sibling
 * can't be removed it throws WITHOUT touching the `.db`. Rationale: a fresh
 * empty `.db` recreated on the next boot next to a leftover `-wal`/`-journal`
 * would replay the stale journal and silently re-corrupt (see
 * `importRawSqliteDb`). A surviving corrupt `.db` is recoverable (retry); a
 * journal replay onto a fresh DB is not.
 */
export async function deleteLocalSqliteDb(userId: string): Promise<void> {
  const dbFilename = dbFilenameForUser(userId)
  const root = await navigator.storage.getDirectory()

  // SQLite's journals first, and bail before the `.db` if any resisted: left
  // beside a fresh database of this name they would be replayed onto it.
  // Attempt all of them even if one fails, so one locked file doesn't mask the
  // rest.
  const journalResults = await Promise.allSettled(
    SQLITE_JOURNAL_SUFFIXES.map(suffix => removeEntryIfExists(root, dbFilename + suffix)),
  )
  const journalFailure = journalResults.find((r): r is PromiseRejectedResult => r.status === 'rejected')
  if (journalFailure) {
    throw new Error(
      'Could not delete all local database files — one may be locked by another open tab of this app. ' +
      'The main database was left in place; close the other tabs and try again.',
      {cause: journalFailure.reason},
    )
  }

  await removeEntryIfExists(root, dbFilename)

  // The write-ahead pair goes AFTER the main file, and its failure is not fatal.
  // The other order loses data: deleting a log while its `.db` survives strips
  // committed frames from a database the caller is then told was left intact.
  // This way a surviving log is harmless — the VFS truncates both sidecars when
  // it opens a `.db` that does not exist yet.
  await Promise.allSettled(
    WRITE_AHEAD_SIDECAR_SUFFIXES.map(suffix => removeEntryIfExists(root, dbFilename + suffix)),
  )
}

/**
 * Remove any leftover recovery-backup `.zip` temp files for this user. The
 * recovery backup streams a full-size zip into an OPFS temp and relies on
 * `downloadBlob`'s delayed cleanup timer — but the reset path reloads the page,
 * which cancels that timer and would otherwise leak gigabytes of OPFS quota. The
 * reset calls this before reloading; it's safe to drop the temp because the
 * recovery UI only unlocks reset after the user confirmed the download saved.
 * Best-effort and idempotent.
 */
export async function removeRecoveryBackupTemps(userId: string): Promise<void> {
  const prefix = `.${dbFilenameForUser(userId)}.recovery-zip-`
  const root = await navigator.storage.getDirectory()
  const stale: string[] = []
  for await (const name of root.keys()) {
    if (name.startsWith(prefix) && name.endsWith('.tmp')) stale.push(name)
  }
  await Promise.all(stale.map(name => removeEntryIfExists(root, name)))
}

const BYTES_PER_MIB = 1024 * 1024

const estimateFreeOpfsBytes = async (): Promise<number | undefined> => {
  if (typeof navigator.storage?.estimate !== 'function') return undefined
  const {quota, usage} = await navigator.storage.estimate()
  if (typeof quota !== 'number' || typeof usage !== 'number') return undefined
  return Math.max(0, quota - usage)
}

const insufficientOpfsSpaceMessage = (
  requiredBytes: number,
  freeBytes: number | undefined,
): string => {
  const toMiB = (bytes: number) => (bytes / BYTES_PER_MIB).toFixed(1)
  // Only quote the free-space estimate when it actually explains the failure
  // (free < required). The QuotaExceededError fallback re-estimates *after* the
  // write already failed, and some browsers (Firefox) report a disk/group quota
  // far larger than the real per-origin OPFS limit the write hit — quoting it
  // would contradict the "not enough storage" framing, e.g. "needs 4124.2 MiB
  // but only 452126.3 MiB is available".
  const haveClause = freeBytes !== undefined && freeBytes < requiredBytes
    ? ` but only ${toMiB(freeBytes)} MiB is available`
    : ''
  // Only mention a different browser when the direct-to-file picker is the
  // thing this environment is missing; on Chromium it would have been used.
  // Each browser keeps its own separate OPFS database, so exporting from
  // another browser would export that browser's data — freeing space here is
  // the only way to export *this* browser's database.
  const pickerHint = typeof (globalThis as WindowWithSaveFilePicker).showSaveFilePicker === 'function'
    ? ''
    : ' (A Chromium-based browser can export without this temporary copy, but it keeps its own separate local database and would not include anything that exists only in this browser, such as unsynced changes or local history.)'
  return (
    `Not enough browser storage to export the SQLite database: the export first copies ` +
    `it into browser storage (OPFS), which needs ${toMiB(requiredBytes)} MiB of free space` +
    `${haveClause}. Free up storage for this site and try again.${pickerHint}`
  )
}

// `downloadBlob` moved to a light standalone util (`./downloadBlob.js`) so callers
// that only need the transient-anchor download (e.g. the media renderer) don't pull
// in this module's fflate / repoProvider deps. Re-exported here for existing importers.
export { downloadBlob } from './downloadBlob.js'

// SQLite db files start with 16 bytes "SQLite format 3" + NUL. Built
// from a byte array on purpose — embedding the literal NUL in a string
// literal would make git treat this source file as binary.
const SQLITE_MAGIC = new Uint8Array([
  0x53, 0x51, 0x4c, 0x69, 0x74, 0x65, 0x20,
  0x66, 0x6f, 0x72, 0x6d, 0x61, 0x74, 0x20, 0x33, 0x00,
])

/**
 * Replace the current user's OPFS .db file with the supplied bytes.
 * After this resolves the live `repo` is dead (its DB connection has
 * been closed); the caller must reload the page so a fresh PowerSync
 * init opens the new file.
 */
export async function importRawSqliteDb(repo: Repo, file: File): Promise<void> {
  // Cheap header check so a wrong-file selection fails before we
  // tear down the live database.
  if (file.size < SQLITE_MAGIC.length) {
    throw new Error('Selected file is too small to be a SQLite database.')
  }
  const headerBuffer = await file.slice(0, SQLITE_MAGIC.length).arrayBuffer()
  const head = new Uint8Array(headerBuffer)
  for (let i = 0; i < SQLITE_MAGIC.length; i++) {
    if (head[i] !== SQLITE_MAGIC[i]) {
      throw new Error('Selected file is not a SQLite database (missing magic header).')
    }
  }

  const userId = repo.user.id
  const dbFilename = dbFilenameForUser(userId)
  const stagingName = tempOpfsFilename(dbFilename, 'import-staging')

  const root = await navigator.storage.getDirectory()
  const stagingHandle = await root.getFileHandle(stagingName, {create: true})

  try {
    await pipeBlobToFileHandle(file, stagingHandle)

    // Release the OPFS sync access handle the worker holds on the .db
    // file; without this, createWritable() throws NoModificationAllowedError.
    await repo.db.close()

    // Rollback-journal mode normally deletes -journal on clean close and
    // we don't run native SQLite WAL, but be defensive — a leftover sibling
    // from a crashed prior session would be replayed against the freshly
    // imported DB and silently corrupt it.
    for (const suffix of DB_FILE_SIBLING_SUFFIXES) {
      await removeEntryIfExists(root, dbFilename + suffix)
    }

    const replacement = await stagingHandle.getFile()
    const fileHandle = await root.getFileHandle(dbFilename, {create: true})
    await pipeBlobToFileHandle(replacement, fileHandle)
  } finally {
    await removeEntryIfExists(root, stagingName)
  }
}

/**
 * Whether a `PRAGMA wal_checkpoint` result says nothing is left outstanding.
 *
 * Read positionally because the two VFSes answer differently, and the first
 * cell means "nothing outstanding" as zero under both: `OPFSWriteAheadVFS`
 * returns one cell whose column NAME is the remaining page count, while under
 * `OPFSCoopSyncVFS` SQLite answers its own pragma with `busy, log, checkpointed`
 * — busy 0 in rollback-journal mode, where there is no WAL to drain at all.
 *
 * An unrecognised shape is NOT drained: the caller is about to copy the main
 * file alone, and a loud refusal beats a backup that quietly omits writes.
 */
const EXPORT_LOCK_TIMEOUT_MS = 180_000

const withDeadline = async <T,>(work: Promise<T>, ms: number, message: string): Promise<T> => {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      work,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(message)), ms)
      }),
    ])
  } finally {
    clearTimeout(timer)
  }
}

const checkpointDrained = (result: unknown): boolean => {
  const rows = (result as {rows?: {_array?: unknown[]}} | undefined)?.rows?._array
  const row = Array.isArray(rows) ? rows[0] : undefined
  if (!row || typeof row !== 'object') return false
  const [value] = Object.values(row as Record<string, unknown>)
  return Number(value) === 0
}

/**
 * Run `callback` with NO other writer able to touch the database, having first
 * flushed everything into the main `.db` file.
 *
 * Both are required because the export copies the main file's raw bytes. Under
 * OPFSWriteAheadVFS committed transactions sit in the `-wa*` sidecars until
 * checkpointed, so an un-checkpointed export is an intact-looking database
 * missing its most recent writes (the checkpoint is a no-op under
 * OPFSCoopSyncVFS). And the two steps have to share ONE exclusion: a writer
 * admitted between them commits straight back into a sidecar, putting the
 * staleness back. It is a WRITE lock rather than a read lock because with a
 * reader pool a read lock no longer excludes the writer at all.
 */
const withCheckpointedDbLock = async <T,>(repo: Repo, callback: () => Promise<T>): Promise<T> => {
  const db = repo.db as unknown as Partial<PowerSyncWriteLockDb>
  if (typeof db.writeLock !== 'function') {
    throw new Error('PowerSync database does not expose writeLock; cannot safely snapshot live SQLite DB.')
  }
  // The deadline wraps the WHOLE lock, not the checkpoint inside it. A deadline
  // on the statement alone cannot surface: `writeLock`'s own `finally` awaits
  // `completeAccess` on the same connection, which queues behind the statement
  // that is still stuck — so the lock promise never settles and the rejection
  // is never seen. Wrapping the lock gives the caller its error while the lease
  // rots; only a reload frees that, which is what the message asks for.
  //
  // Generous, because it also covers copying the database — this exists to
  // break a hang, not to bound a legitimate export. A very large database on
  // slow storage could in principle trip it.
  return withDeadline(db.writeLock(async tx => {
    // Through `tx`, not `repo.db.execute` — the latter would queue for the
    // write lock this callback is already holding.
    await tx.execute('PRAGMA wal_checkpoint=truncate')
    // A partial checkpoint does not fail the statement, and the copy below
    // takes only the main file — so an unverified flush yields a backup that
    // opens cleanly and is missing its most recent writes. Same confirmation
    // the VFS handoff makes before it discards a log.
    if (!checkpointDrained(await tx.execute('PRAGMA wal_checkpoint=noop'))) {
      throw new Error(
        'Could not flush this device\'s pending changes into the database file, so a backup taken now ' +
        'would be missing them. Another tab of the app is probably still holding the database — close ' +
        'the other tabs and try again.',
      )
    }
    return callback()
  }), EXPORT_LOCK_TIMEOUT_MS,
    'Timed out preparing this device\'s database for backup. Another tab of the app is probably ' +
    'holding it — close the other tabs, reload, and try again.',
  )
}

const pipeBlobToFileHandle = async (
  blob: Blob,
  fileHandle: FileSystemFileHandle,
): Promise<void> => {
  const writable = await fileHandle.createWritable({keepExistingData: false})
  await blob.stream().pipeTo(writable)
}

const removeEntryIfExists = async (
  root: FileSystemDirectoryHandle,
  name: string,
): Promise<void> => {
  try {
    await root.removeEntry(name)
  } catch (err) {
    if (!(err instanceof DOMException && err.name === 'NotFoundError')) {
      throw err
    }
  }
}

const readOpfsFileIfExists = async (
  root: FileSystemDirectoryHandle,
  name: string,
): Promise<File | null> => {
  try {
    const handle = await root.getFileHandle(name)
    return await handle.getFile()
  } catch (err) {
    if (err instanceof DOMException && err.name === 'NotFoundError') return null
    throw err
  }
}

/**
 * Stream a STORED (uncompressed) zip of the given OPFS files into a new OPFS
 * temp file, returning its handle. Streamed (not `zipSync`) because the `.db`
 * can be gigabytes: each file is piped disk → zip → disk with backpressure, so
 * we never hold the whole archive in memory. Store mode keeps it CPU-light —
 * compressing an already-dense SQLite file buys almost nothing. On any failure
 * the partial temp file is removed before the error propagates.
 */
const streamStoredZipToOpfs = async (
  root: FileSystemDirectoryHandle,
  entries: Array<{ name: string; file: File }>,
  tempName: string,
): Promise<FileSystemFileHandle> => {
  const tempHandle = await root.getFileHandle(tempName, { create: true })
  const writable = await tempHandle.createWritable({ keepExistingData: false })

  let writeChain: Promise<void> = Promise.resolve()
  let zipError: unknown = null
  const zip = new Zip((err, chunk) => {
    if (err) {
      zipError = err
      return
    }
    writeChain = writeChain.then(() => writable.write(chunk))
  })

  try {
    for (const { name, file } of entries) {
      const passthrough = new ZipPassThrough(name)
      zip.add(passthrough)
      const reader = file.stream().getReader()
      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        passthrough.push(value, false)
        // Backpressure: wait for queued writes so memory stays ~one chunk.
        await writeChain
        if (zipError) throw zipError
      }
      passthrough.push(new Uint8Array(0), true)
    }
    zip.end()
    await writeChain
    if (zipError) throw zipError
    await writable.close()
  } catch (err) {
    await writable.abort?.().catch(() => {})
    await removeEntryIfExists(root, tempName)
    throw err
  }
  return tempHandle
}

const tempOpfsFilename = (dbFilename: string, purpose: string): string =>
  `.${dbFilename}.${purpose}-${Date.now()}-${uuidv4()}.tmp`
