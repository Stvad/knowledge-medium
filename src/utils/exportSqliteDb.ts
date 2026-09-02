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
 * Import validates a tiny header first, streams the selection into OPFS
 * staging while the live DB is still intact, then closes PowerSync and
 * replaces the current user's files from staging. The selection is a `.db`, a
 * recovery archive, or a `.db` with the siblings extracted from one — a lone
 * `.db` restored from a backup that had write-ahead sidecars is missing
 * whatever they still held, and says nothing about it.
 */

import { v4 as uuidv4 } from 'uuid'
import { Zip, ZipPassThrough } from 'fflate'
import type { Repo } from '../data/repo'
import { dbFilenameForUser } from '@/data/localDbStorage'
import { supportsWriteAheadVfs } from '@/data/localDbVfs.js'
import {
  DB_FILE_SIBLING_SUFFIXES,
  SQLITE_JOURNAL_SUFFIXES,
  SQLITE_ROLLBACK_JOURNAL_SUFFIX,
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
  const size = await withCheckpointedDbLock(repo, async signal => {
    const sourceFile = await fileHandle.getFile()
    await pipeBlobToFileHandle(sourceFile, destinationHandle, signal)
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
    await withCheckpointedDbLock(repo, async signal => {
      // A FRESH handle: `sourceFile` above predates the checkpoint, so piping it
      // would copy the file as it stood before the sidecars were folded in.
      await pipeBlobToFileHandle(await sourceHandle.getFile(), snapshotHandle, signal)
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

/** ZIP local-file-header magic, `PK\x03\x04`. */
const ZIP_MAGIC = new Uint8Array([0x50, 0x4b, 0x03, 0x04])

const startsWithMagic = async (blob: Blob, magic: Uint8Array): Promise<boolean> => {
  if (blob.size < magic.length) return false
  const head = new Uint8Array(await blob.slice(0, magic.length).arrayBuffer())
  return magic.every((byte, i) => head[i] === byte)
}

/** Injection seam for the tests; production uses the real probe. */
export interface ImportDeps {
  probeWriteAheadSupport?: () => Promise<boolean>
}

/**
 * Room for the SECOND copy, checked at the last moment before the boundary.
 *
 * Staging is already on disk by now, so `estimate()` accounts for it and the
 * only outstanding cost is writing those bytes again under the real names —
 * paid for, in part, by deleting the database being replaced. Anything left
 * over has to be free already.
 *
 * Measuring here rather than up front is what makes it right: the staged files
 * are the actual uncompressed bytes, so a deflated archive cannot undercount,
 * and the database's real size is known rather than assumed. Running out of
 * room during staging is merely a failed import; running out after the boundary
 * destroys the database.
 */
const assertRoomToReplace = async (
  root: FileSystemDirectoryHandle,
  dbFilename: string,
  staged: readonly StagedImportFile[],
): Promise<void> => {
  const freeBytes = await estimateFreeOpfsBytes()
  if (freeBytes === undefined) return

  let stagedBytes = 0
  for (const {stagingName} of staged) stagedBytes += (await opfsFile(root, stagingName)).size
  let reclaimable = 0
  for (const suffix of ['', ...DB_FILE_SIBLING_SUFFIXES]) {
    reclaimable += (await readOpfsFileIfExists(root, dbFilename + suffix))?.size ?? 0
  }

  const required = stagedBytes - reclaimable
  if (freeBytes < required) throw new Error(insufficientOpfsSpaceMessage(required, freeBytes))
}

/** One file waiting in OPFS staging, and the sibling suffix it restores to (`''` = the `.db`). */
interface StagedImportFile {
  suffix: string
  stagingName: string
}

/**
 * Which member of a fileset is the database, and what each of the rest restores
 * to. Matched by SHAPE — the database is the one member every other member
 * extends by a known sibling suffix — so a backup taken under one account still
 * restores under another, as a bare `.db` always could.
 *
 * A fileset needs a database, and the caller's header check enforces it. Do not
 * relax that to accept the sibling-only backup `getRawSqliteDbBackup` can
 * produce (a hot journal beside a 0-byte `.db`): writing a journal with no
 * database is the case `dbFileSiblings` exists to prevent — the next boot
 * creates a fresh `.db` and SQLite replays the stale journal onto it. That
 * backup is for reading offline with `sqlite3 .recover`, not for restoring.
 */
const classifyDbFileSet = (names: readonly string[]): {main: string; siblings: Array<{name: string; suffix: string}>} => {
  const main = new Set(names).size === names.length
    ? names.find(candidate => names.every(name =>
        name === candidate || DB_FILE_SIBLING_SUFFIXES.some(suffix => name === candidate + suffix)))
    : undefined
  if (!main) {
    throw new Error(
      'Select a SQLite database file on its own, or together with the ' +
      `${DB_FILE_SIBLING_SUFFIXES.join(' / ')} siblings saved beside it in the same backup.`,
    )
  }
  return {
    main,
    siblings: names.filter(name => name !== main).map(name => ({name, suffix: name.slice(main.length)})),
  }
}

/**
 * The sibling sets a restore may put BACK — deliberately narrower than
 * `DB_FILE_SIBLING_SUFFIXES`, which the deletion sweep uses. Deletion clears
 * anything SQLite could replay, whoever wrote it; a restore writes only what
 * this app produces and can open again.
 *
 * A fileset draws from ONE group: the write-ahead pair, or the rollback
 * journal. Both at once is a state no database has, and `prepareLocalDbForVfs`
 * refuses it at boot. `-wal`/`-shm` are in neither group, because they only
 * accompany a WAL-mode database — see `assertRestorableDatabase`.
 *
 * A whitelist rather than a list of rejected combinations: the failure being
 * excluded is "restores cleanly, then cannot boot", and each new way to reach
 * it is invisible until someone hits it.
 */
const RESTORABLE_SIBLING_GROUPS: ReadonlyArray<readonly string[]> = [
  WRITE_AHEAD_SIDECAR_SUFFIXES,
  [SQLITE_ROLLBACK_JOURNAL_SUFFIX],
]

const assertRestorableSet = (siblingSuffixes: readonly string[]): void => {
  if (RESTORABLE_SIBLING_GROUPS.some(group => siblingSuffixes.every(s => group.includes(s)))) return
  throw new Error(
    'These files cannot be restored together. Select the database on its own, with its ' +
    `${WRITE_AHEAD_SIDECAR_SUFFIXES.join(' / ')} pair, or with its ` +
    `${SQLITE_ROLLBACK_JOURNAL_SUFFIX} — from one backup.`,
  )
}

/**
 * Restoring a write-ahead pair COMMITS this device to `OPFSWriteAheadVFS`:
 * `resolveLocalDbVfs` picks it on sidecar existence alone, ahead of both the pin
 * and the probe, because the sidecars are the record of where the database
 * lives. On a browser without `readwrite-unsafe` that database then cannot be
 * opened at all, and the screen it lands on offers only Reload — with the app
 * unmounted, the import action is out of reach.
 *
 * So refuse before staging. Dropping the sidecars instead is NOT the fallback to
 * suggest: that is the silent loss this whole path exists to close, so the
 * message has to say the transactions would go with them.
 *
 * Probed only when the fileset actually carries sidecars — the probe spawns a
 * worker and can take seconds, and every other restore is unaffected by it.
 */
const assertWriteAheadRestorable = async (
  root: FileSystemDirectoryHandle,
  dbFilename: string,
  siblingSuffixes: readonly string[],
  probe: () => Promise<boolean>,
): Promise<void> => {
  const wantsWriteAhead = siblingSuffixes.some(suffix =>
    (WRITE_AHEAD_SIDECAR_SUFFIXES as readonly string[]).includes(suffix))
  if (!wantsWriteAhead) return

  // Sidecars on this device settle it without asking: they only exist because
  // this browser opened a write-ahead database here. Worth checking FIRST,
  // because the probe answers a transient failure as "no" and caches it for the
  // page — a contract written for deciding about a database that has not moved,
  // where "no" is merely conservative. Here it would refuse a valid backup.
  for (const suffix of WRITE_AHEAD_SIDECAR_SUFFIXES) {
    if (await readOpfsFileIfExists(root, dbFilename + suffix)) return
  }
  if (await probe()) return

  throw new Error(
    'This backup carries a write-ahead log, and this browser could not confirm it can open one ' +
    '— only Chromium-based browsers can. Restore it there. Importing the database file on its ' +
    'own would work here, but every transaction still held in the log would be lost without warning.',
  )
}

/** Bytes 18 and 19 of a SQLite header: 1 = rollback journal, 2 = WAL. */
const SQLITE_WAL_FORMAT_VERSION = 2
const SQLITE_HEADER_PROBE_BYTES = 20

const assertRestorableDatabase = async (blob: Blob): Promise<void> =>
  assertRestorableDatabaseHead(new Uint8Array(await blob.slice(0, SQLITE_HEADER_PROBE_BYTES).arrayBuffer()))

const assertRestorableDatabaseHead = (head: Uint8Array): void => {
  if (head.length < SQLITE_MAGIC.length) {
    throw new Error('Selected file is too small to be a SQLite database.')
  }
  if (!SQLITE_MAGIC.every((byte, i) => head[i] === byte)) {
    throw new Error('Selected file is not a SQLite database (missing magic header).')
  }
  // `OPFSWriteAheadVFS` throws on SQLITE_OPEN_WAL and is the default now, so a
  // database left in WAL mode replaces a working one with one that cannot open
  // at all. Nothing here writes WAL mode; such a file came from elsewhere, and
  // the sibling whitelist cannot see this because a bare `.db` carries the mode
  // in its own header. (A file too short to have the field reads as undefined,
  // which is not 2.)
  if (head[18] === SQLITE_WAL_FORMAT_VERSION || head[19] === SQLITE_WAL_FORMAT_VERSION) {
    throw new Error(
      'This database is in WAL journal mode, which this app cannot open. Convert it first ' +
      "— sqlite3 <file> 'PRAGMA journal_mode=delete' — and import it again.",
    )
  }
}

const opfsFile = async (root: FileSystemDirectoryHandle, name: string): Promise<File> =>
  (await root.getFileHandle(name)).getFile()

/** The selection, classified and header-checked, before OPFS is touched at all. */
const validateSelection = async (
  files: readonly File[],
): Promise<Array<{suffix: string; file: File}>> => {
  const {main, siblings} = classifyDbFileSet(files.map(file => file.name))
  const byName = new Map(files.map(file => [file.name, file]))
  await assertRestorableDatabase(byName.get(main)!)
  assertRestorableSet(siblings.map(({suffix}) => suffix))
  return [
    {suffix: '', file: byName.get(main)!},
    ...siblings.map(({name, suffix}) => ({suffix, file: byName.get(name)!})),
  ]
}

const stageSelection = async (
  root: FileSystemDirectoryHandle,
  dbFilename: string,
  selection: Array<{suffix: string; file: File}>,
  temps: string[],
): Promise<StagedImportFile[]> => {
  const staged: StagedImportFile[] = []
  for (const {suffix, file} of selection) {
    const stagingName = tempOpfsFilename(dbFilename, 'import-staging')
    temps.push(stagingName)
    await pipeBlobToFileHandle(file, await root.getFileHandle(stagingName, {create: true}))
    staged.push({suffix, stagingName})
  }
  return staged
}

/**
 * Copy one member into OPFS staging, checked against the directory's own record
 * of it as the bytes go past.
 *
 * The size check is not redundant with slicing the range: a deflated member
 * expands to whatever it expands to, and a stored one can still be short if the
 * archive was cut inside it.
 */
const stageZipMember = async (
  root: FileSystemDirectoryHandle,
  archive: Blob,
  entry: ZipDirectoryEntry,
  stagingName: string,
): Promise<void> => {
  const refuse = (detail: string): never => {
    throw new Error(
      `The selected archive is damaged — ${detail}. ` +
      'Re-download the backup, or extract it and select the files inside.',
    )
  }

  const content = await readZipMember(archive, entry)
  let crc = -1
  let written = 0
  const writable = await (await root.getFileHandle(stagingName, {create: true}))
    .createWritable({keepExistingData: false})
  await content.pipeTo(new WritableStream<Uint8Array>({
    write: async chunk => {
      crc = crc32(chunk, crc)
      written += chunk.length
      await writable.write(chunk as unknown as FileSystemWriteChunkType)
    },
    close: () => writable.close(),
    abort: reason => writable.abort?.(reason),
  }))
  if (written !== entry.size) {
    refuse(`"${entry.name}" should hold ${entry.size} bytes but ${written} could be read`)
  }
  if (((crc ^ -1) >>> 0) !== entry.crc) {
    refuse(`the contents of "${entry.name}" do not match its checksum`)
  }
}

/**
 * Unpack a recovery archive into OPFS staging, one temp file per member.
 *
 * Everything that can refuse the archive runs BEFORE a byte is extracted. The
 * directory carries every member's name, so the fileset can be classified,
 * checked against the restorable groups and tested for browser support up
 * front, and the database header comes from a 20-byte slice rather than a
 * staged copy. On a multi-gigabyte backup that is the difference between a
 * deterministic refusal and a long copy that can exhaust the quota first.
 */
const stageRecoveryArchive = async (
  root: FileSystemDirectoryHandle,
  dbFilename: string,
  archive: File,
  temps: string[],
  probe: () => Promise<boolean>,
): Promise<StagedImportFile[]> => {
  const declared = await zipCentralDirectory(archive)
  const {main, siblings} = classifyDbFileSet(declared.map(entry => entry.name))
  assertRestorableSet(siblings.map(({suffix}) => suffix))
  await assertWriteAheadRestorable(root, dbFilename, siblings.map(({suffix}) => suffix), probe)

  const byName = new Map(declared.map(entry => [entry.name, entry]))
  assertRestorableDatabaseHead(
    await readStreamPrefix(await readZipMember(archive, byName.get(main)!), SQLITE_HEADER_PROBE_BYTES),
  )

  const staged: StagedImportFile[] = []
  for (const {name, suffix} of [{name: main, suffix: ''}, ...siblings]) {
    const stagingName = tempOpfsFilename(dbFilename, 'import-staging')
    temps.push(stagingName)
    await stageZipMember(root, archive, byName.get(name)!, stagingName)
    staged.push({suffix, stagingName})
  }
  return staged
}

/**
 * Replace the current user's OPFS database from files the user selected: a raw
 * `.db`, a recovery archive from `getRawSqliteDbBackup`, or the `.db` together
 * with the siblings extracted from one.
 *
 * Restoring the siblings is the point. A backup captured with committed frames
 * still in the write-ahead sidecars, restored as a lone `.db`, opens fine and
 * reports `integrity_check` ok with those transactions gone.
 *
 * After this resolves the live `repo` is dead (its DB connection has been
 * closed); the caller must reload the page so a fresh PowerSync init opens the
 * new files.
 */
export async function importRawSqliteDb(
  repo: Repo,
  files: readonly File[],
  {probeWriteAheadSupport = supportsWriteAheadVfs}: ImportDeps = {},
): Promise<void> {
  const isArchive = files.length === 1 && await startsWithMagic(files[0], ZIP_MAGIC)
  // Classified and header-checked before OPFS is touched at all, so a
  // wrong-file pick costs nothing and leaves nothing behind.
  const selection = isArchive ? null : await validateSelection(files)

  const dbFilename = dbFilenameForUser(repo.user.id)
  const root = await navigator.storage.getDirectory()

  // Needs OPFS to read, so it cannot join the checks above — but it still only
  // READS, and still runs before anything is staged or removed.
  if (selection) {
    await assertWriteAheadRestorable(root, dbFilename, selection.map(({suffix}) => suffix), probeWriteAheadSupport)
  }

  // Everything lands in staging while the live database is still intact, so a
  // failure reading the selection leaves that database untouched.
  const temps: string[] = []
  try {
    const staged = selection === null
      ? await stageRecoveryArchive(root, dbFilename, files[0], temps, probeWriteAheadSupport)
      : await stageSelection(root, dbFilename, selection, temps)

    // Last thing before the boundary, because it needs the staged sizes.
    await assertRoomToReplace(root, dbFilename, staged)

    // Release the OPFS sync access handle the worker holds on the .db
    // file; without this, createWritable() throws NoModificationAllowedError.
    await repo.db.close()

    // The original `.db` goes FIRST. Every sibling has to be gone before the
    // replacement lands — a journal or a write-ahead log beside a new file of
    // that name gets replayed onto it — but removing siblings while the old
    // `.db` still stands means a failure part-way leaves that database short of
    // its own committed frames, which is the one outcome worth avoiding here.
    //
    // `removeEntryIfExists` rethrows anything that is not NotFoundError, so
    // this is also the check: nothing is written onto a file that resisted
    // removal. It sits OUTSIDE the try below because it is the boundary. Until
    // it succeeds the old database is whole and none of it may be touched — a
    // `.db` another tab still holds throws here, and stripping that database's
    // journal on the way out would lose the very frames it exists to keep.
    await removeEntryIfExists(root, dbFilename)

    // Past this line the old database is gone and the new one is not there yet,
    // so ANY failure has to take the rest down with it — see the catch. Only
    // the write-ahead pair is safe to strand; a stranded `-journal`/`-wal` is
    // not inert at all, SQLite replays it onto the fresh database the next boot
    // creates.
    try {
      for (const suffix of DB_FILE_SIBLING_SUFFIXES) {
        await removeEntryIfExists(root, dbFilename + suffix)
      }

      // Writing back runs the other way: siblings first, the `.db` LAST, so no
      // moment of the successful path has a complete-looking database sitting
      // without the log its own committed frames are still in.
      const lastFirst = [...staged.filter(f => f.suffix !== ''), ...staged.filter(f => f.suffix === '')]
      for (const {suffix, stagingName} of lastFirst) {
        const replacement = await opfsFile(root, stagingName)
        const fileHandle = await root.getFileHandle(dbFilename + suffix, {create: true})
        await pipeBlobToFileHandle(replacement, fileHandle)
      }
    } catch (err) {
      await discardLocalDbFiles(root, dbFilename)
      // The caller shows this as "import failed", which every reader takes to
      // mean nothing happened. Past the boundary the previous database is
      // already gone, so say so — and say the files they picked are fine, which
      // is the part that decides whether they panic.
      throw new Error(
        `${err instanceof Error ? err.message : String(err)} — and this device's previous ` +
        'database was already removed, so it is now empty. The files you selected are ' +
        'untouched: reload the page and import them again.',
        {cause: err},
      )
    }
  } finally {
    await Promise.allSettled(temps.map(name => removeEntryIfExists(root, name)))
  }
}

const EXPORT_LOCK_TIMEOUT_MS = 180_000

/**
 * On expiry: abort, WAIT for the abort to settle, then reject.
 *
 * Aborting alone is not enough. `pipeTo`'s abort procedure is asynchronous, so
 * returning immediately hands control back while the writable is still closing
 * — and the caller's cleanup then deletes a snapshot whose writable is open,
 * replacing the actionable timeout with `NoModificationAllowedError`.
 *
 * The wait is bounded because not everything is abortable: a checkpoint stuck
 * on another connection's transaction-id lock ignores the signal entirely, and
 * waiting on it forever would restore the hang this deadline exists to break.
 */
const ABORT_SETTLE_GRACE_MS = 5_000

const TIMED_OUT = Symbol('timed-out')

const withDeadline = async <T,>(
  work: (signal: AbortSignal) => Promise<T>,
  ms: number,
  message: string,
): Promise<T> => {
  const controller = new AbortController()
  const running = work(controller.signal)
  // Settled either way, so the work is never an unhandled rejection while the
  // timer decides — and so its outcome can be inspected rather than raced.
  const settled = running.then(
    value => ({value}),
    (error: unknown) => ({error}),
  )

  let timer: ReturnType<typeof setTimeout> | undefined
  let graceTimer: ReturnType<typeof setTimeout> | undefined
  try {
    // The race is decided by the TIMER, not by the work's rejection. Racing the
    // work itself hands back its `AbortError` — which this very deadline
    // caused — in place of the message that tells the user what to do.
    const outcome = await Promise.race([
      settled,
      new Promise<typeof TIMED_OUT>(resolve => {
        timer = setTimeout(() => resolve(TIMED_OUT), ms)
      }),
    ])
    if (outcome !== TIMED_OUT) {
      if ('error' in outcome) throw outcome.error
      return outcome.value
    }

    controller.abort()
    // Let the abort procedure close the writable before the caller's cleanup
    // touches the file — bounded, because a checkpoint stuck on another
    // connection's lock ignores the signal and would restore the hang.
    await Promise.race([
      settled,
      new Promise<void>(resolve => { graceTimer = setTimeout(resolve, ABORT_SETTLE_GRACE_MS) }),
    ])
    throw new Error(message)
  } finally {
    clearTimeout(timer)
    clearTimeout(graceTimer)
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
const withCheckpointedDbLock = async <T,>(
  repo: Repo,
  callback: (signal: AbortSignal) => Promise<T>,
): Promise<T> => {
  const maybeDb = repo.db as unknown as Partial<PowerSyncWriteLockDb>
  if (typeof maybeDb.writeLock !== 'function') {
    throw new Error('PowerSync database does not expose writeLock; cannot safely snapshot live SQLite DB.')
  }
  const db = maybeDb as PowerSyncWriteLockDb
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
  return withDeadline(signal => db.writeLock(async tx => {
    // The lock REQUEST is not abortable, so this callback can start long after
    // the deadline gave up — the abort only reaches work already running. Bail
    // before the checkpoint, which is the expensive half and holds the writer
    // for everyone else.
    if (signal.aborted) throw new Error('Export abandoned before the database lock was granted.')
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
    // Again before the copy: the checkpoint above can itself outlast the
    // deadline, and the copy writes to the caller's chosen destination.
    if (signal.aborted) throw new Error('Export abandoned before the copy began.')
    return callback(signal)
  }), EXPORT_LOCK_TIMEOUT_MS,
    'Timed out preparing this device\'s database for backup. Another tab of the app is probably ' +
    'holding it — close the other tabs, reload, and try again.',
  )
}

const pipeBlobToFileHandle = async (
  blob: Blob,
  fileHandle: FileSystemFileHandle,
  signal?: AbortSignal,
): Promise<void> => {
  const writable = await fileHandle.createWritable({keepExistingData: false})
  // Through `pipeTo`, so an abort tears down the writable too — a copy that
  // merely stops being awaited keeps writing.
  await blob.stream().pipeTo(writable, {signal})
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

/**
 * Best-effort teardown of a half-replaced database, in the deletion order
 * `dbFileSiblings` sets out: journals first, then the `.db`, then the
 * write-ahead pair. Used when a restore fails between taking the old files
 * down and getting the new ones in — leaving the journals there would hand the
 * next boot a stale rollback log to replay onto a fresh database.
 */
const discardLocalDbFiles = async (
  root: FileSystemDirectoryHandle,
  dbFilename: string,
): Promise<void> => {
  for (const suffixes of [SQLITE_JOURNAL_SUFFIXES, [''], WRITE_AHEAD_SIDECAR_SUFFIXES]) {
    await Promise.allSettled(suffixes.map(suffix => removeEntryIfExists(root, dbFilename + suffix)))
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
 * we never hold the whole archive in memory. On any failure the partial temp
 * file is removed before the error propagates.
 *
 * Stored for CPU, NOT because compressing a SQLite file would be futile — it
 * compresses well. Deflate in JS runs at tens of MB/s and this path executes
 * when the database will not open, so a multi-gigabyte backup would block at
 * the moment the user most needs their bytes. `CompressionStream` is fast
 * enough but does not fit fflate's writer.
 *
 * Storing also makes the archive's 32-bit size fields bind on the TOTAL rather
 * than on the largest member (#867).
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

const LOCAL_HEADER_SIZE = 30
const ZIP_METHOD_STORED = 0
const ZIP_METHOD_DEFLATE = 8

/**
 * Copy one member's bytes out of the archive, by ADDRESS.
 *
 * Not by streaming search, which is what fflate's `Unzip` does and what made
 * this wrong: `streamStoredZipToOpfs` writes through fflate's streaming `Zip`,
 * which sets the data-descriptor flag and leaves the local header sizes at
 * zero, so a reader that cannot see the directory has to scan the payload for
 * the next zip signature — and a database whose own bytes contain `PK\x07\x08`
 * ends there. The central directory records where every member starts and how
 * long it is, so slicing the range is both correct and cheaper: for a stored
 * member the copy is a Blob view, with no parsing in the middle at all.
 */
const readZipMember = async (archive: Blob, entry: ZipDirectoryEntry): Promise<ReadableStream<Uint8Array>> => {
  // The local header repeats the name and carries its OWN extra field, which
  // the directory's copy does not have to match — so the data offset can only
  // be computed from this header.
  const header = new DataView(
    await archive.slice(entry.localHeaderOffset, entry.localHeaderOffset + LOCAL_HEADER_SIZE).arrayBuffer(),
  )
  if (header.byteLength < LOCAL_HEADER_SIZE || header.getUint32(0, true) !== LOCAL_FILE_SIGNATURE) {
    throw new Error(
      `The selected archive is damaged — the record for "${entry.name}" is missing. ` +
      'Re-download the backup, or extract it and select the files inside.',
    )
  }
  const dataAt = entry.localHeaderOffset + LOCAL_HEADER_SIZE
    + header.getUint16(26, true) + header.getUint16(28, true)
  const stored = archive.slice(dataAt, dataAt + entry.storedSize)
  if (stored.size !== entry.storedSize) {
    throw new Error(
      `The selected archive is damaged — "${entry.name}" runs past the end of it. ` +
      'Re-download the backup, or extract it and select the files inside.',
    )
  }

  if (entry.method === ZIP_METHOD_STORED) return stored.stream()
  if (entry.method !== ZIP_METHOD_DEFLATE) {
    throw new Error(
      `"${entry.name}" is compressed in a way this app cannot read. ` +
      'Extract the archive and select the files inside instead.',
    )
  }
  // Raw deflate — only ever from an archive that has been through an
  // unzip/rezip round trip, since this app writes stored members. Piped, not
  // buffered: a `Response(...).blob()` here would materialise a whole
  // multi-gigabyte database in the renderer.
  return stored.stream().pipeThrough(new DecompressionStream('deflate-raw'))
}

/**
 * The first `byteCount` bytes of a stream, then cancel it. Cancelling is what
 * keeps the header check cheap on a deflated member: decompression stops after
 * the prefix instead of running the whole member to inspect 20 bytes.
 */
const readStreamPrefix = async (
  stream: ReadableStream<Uint8Array>,
  byteCount: number,
): Promise<Uint8Array> => {
  const reader = stream.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  try {
    while (total < byteCount) {
      const {done, value} = await reader.read()
      if (done) break
      chunks.push(value)
      total += value.length
    }
  } finally {
    await reader.cancel().catch(() => {})
  }
  const head = new Uint8Array(total)
  let at = 0
  for (const chunk of chunks) {
    head.set(chunk, at)
    at += chunk.length
  }
  return head.subarray(0, byteCount)
}

/** The 4-byte little-endian signatures the zip directory records carry. */
const EOCD_SIGNATURE = 0x06054b50
const CENTRAL_FILE_SIGNATURE = 0x02014b50
const LOCAL_FILE_SIGNATURE = 0x04034b50
const ZIP64_EOCD_LOCATOR_SIGNATURE = 0x07064b50
const EOCD_SIZE = 22
const CENTRAL_FILE_HEADER_SIZE = 46
/** Both 32-bit fields use an all-ones sentinel to mean "see the ZIP64 record". */
const ZIP64_SENTINEL_32 = 0xffffffff

interface ZipDirectoryEntry {
  name: string
  /** Authoritative length. The LOCAL header carries zero for a streamed entry. */
  size: number
  crc: number
  /** 0 = stored, 8 = deflate. Everything this app writes is stored. */
  method: number
  storedSize: number
  localHeaderOffset: number
}

/**
 * The archive's central directory: one authoritative record per member.
 *
 * This is not belt-and-braces over the streaming reader — it is the only
 * trustworthy account of what the archive holds. `streamStoredZipToOpfs` writes
 * through fflate's streaming `Zip`, which always sets the data-descriptor flag
 * and leaves the sizes in each LOCAL header as zero, so `Unzip` cannot know
 * where a member ends and scans the payload for the next zip signature instead.
 * A `.db` whose own bytes happen to contain `PK\x07\x08` therefore ends early,
 * and every later frame of a sidecar is dropped — silently, because a short
 * `.db` still carries the SQLite magic and a short log reads as end-of-log. On
 * a multi-GB database that sequence is more likely to occur than not.
 *
 * Finding the record also proves the tail is present, which is what rules out a
 * truncated download.
 */
const zipCentralDirectory = async (archive: Blob): Promise<ZipDirectoryEntry[]> => {
  // Past 4 GiB the directory's 32-bit offsets cannot address the archive, and
  // fflate's writer wraps them modulo 2^32 rather than emitting ZIP64 — so an
  // archive this size is malformed at the source, not damaged in transit, and
  // no validation below could tell the difference. Measured: a 4 GiB+ archive
  // records its directory at offset 1076.
  if (archive.size > ZIP64_SENTINEL_32) {
    throw new Error(
      'This backup is larger than 4 GB, which the archive format used to write it cannot ' +
      'describe, so it cannot be restored. Extract it and select the files inside instead.',
    )
  }

  // 22 bytes plus a trailing comment we never write and the format caps at 64K.
  const tailBytes = Math.min(archive.size, EOCD_SIZE + 0xffff)
  const tailStart = archive.size - tailBytes
  const tail = new DataView(await archive.slice(tailStart).arrayBuffer())

  for (let at = tail.byteLength - EOCD_SIZE; at >= 0; at--) {
    if (tail.getUint32(at, true) !== EOCD_SIGNATURE) continue
    // Validate the candidate rather than trusting the first signature found:
    // these bytes can also occur inside member data, or after the record in an
    // archive comment — and the scan runs backwards, so a decoy is seen first.
    // A real record ends exactly at EOF and points at a directory that ends
    // exactly where it begins. The two clauses are independent and either alone
    // catches an accidental decoy; both are kept because a CRAFTED one can
    // satisfy either by itself, and neither is individually pinned by a test.
    if (at + EOCD_SIZE + tail.getUint16(at + 20, true) !== tail.byteLength) continue
    const count = tail.getUint16(at + 10, true)
    const size = tail.getUint32(at + 12, true)
    const offset = tail.getUint32(at + 16, true)
    if (offset + size !== tailStart + at) continue

    // ZIP64 escapes: reading them is worth doing only once an archive that
    // needs one can exist. Ours cannot — fflate writes no ZIP64 — so refuse.
    const zip64 = count === 0xffff || size === ZIP64_SENTINEL_32 || offset === ZIP64_SENTINEL_32
      || (at >= 20 && tail.getUint32(at - 20, true) === ZIP64_EOCD_LOCATOR_SIGNATURE)
    if (zip64) {
      throw new Error(
        'This archive uses the ZIP64 format, which this app cannot verify. ' +
        'Extract it and select the files inside instead.',
      )
    }
    return parseCentralDirectory(new DataView(await archive.slice(offset, offset + size).arrayBuffer()), count)
  }
  throw new Error(
    'The selected archive is truncated — its file directory is missing. ' +
    'Re-download the backup, or extract it and select the files inside.',
  )
}

/**
 * Every record in the directory, read until the directory is CONSUMED rather
 * than until the declared count is reached, and only then reconciled with it.
 *
 * Trusting the count is a silent-subset hazard in a 16-bit field: corrupt a 2
 * down to a 1 and the loop stops after the `.db`, the trailing sidecar's record
 * is never seen, and the import restores a convincing database missing every
 * frame the log still held — with the offset validation above still satisfied,
 * because the directory's position and length did not change.
 */
const parseCentralDirectory = (directory: DataView, count: number): ZipDirectoryEntry[] => {
  const entries: ZipDirectoryEntry[] = []
  const names = new TextDecoder()
  let at = 0
  while (at < directory.byteLength) {
    if (at + CENTRAL_FILE_HEADER_SIZE > directory.byteLength
      || directory.getUint32(at, true) !== CENTRAL_FILE_SIGNATURE) {
      throw new Error('The selected archive\'s file directory is damaged — re-download the backup.')
    }
    const nameLength = directory.getUint16(at + 28, true)
    const size = directory.getUint32(at + 24, true)
    if (size === ZIP64_SENTINEL_32) {
      throw new Error(
        'This archive uses the ZIP64 format, which this app cannot verify. ' +
        'Extract it and select the files inside instead.',
      )
    }
    const localHeaderOffset = directory.getUint32(at + 42, true)
    if (localHeaderOffset === ZIP64_SENTINEL_32) {
      throw new Error(
        'This archive uses the ZIP64 format, which this app cannot verify. ' +
        'Extract it and select the files inside instead.',
      )
    }
    entries.push({
      name: names.decode(new Uint8Array(directory.buffer, directory.byteOffset + at + CENTRAL_FILE_HEADER_SIZE, nameLength)),
      size,
      crc: directory.getUint32(at + 16, true),
      method: directory.getUint16(at + 10, true),
      storedSize: directory.getUint32(at + 20, true),
      localHeaderOffset,
    })
    at += CENTRAL_FILE_HEADER_SIZE + nameLength
      + directory.getUint16(at + 30, true) + directory.getUint16(at + 32, true)
  }
  if (entries.length !== count) {
    throw new Error(
      `The selected archive is damaged — its directory says ${count} file(s) but holds ` +
      `${entries.length}. Re-download the backup, or extract it and select the files inside.`,
    )
  }
  return entries
}

/**
 * CRC-32 (IEEE), streamed. fflate exports no checksum helper, and the archive's
 * directory records one per member — the only content check available on any
 * restore route, so it is worth the table.
 */
const CRC32_TABLE = (() => {
  const table = new Int32Array(256)
  for (let i = 0; i < 256; i++) {
    let value = i
    for (let bit = 0; bit < 8; bit++) value = value & 1 ? (value >>> 1) ^ 0xedb88320 : value >>> 1
    table[i] = value
  }
  return table
})()

const crc32 = (bytes: Uint8Array, seed: number): number => {
  let crc = seed
  for (let i = 0; i < bytes.length; i++) crc = (crc >>> 8) ^ CRC32_TABLE[(crc ^ bytes[i]) & 0xff]
  return crc
}

const tempOpfsFilename = (dbFilename: string, purpose: string): string =>
  `.${dbFilename}.${purpose}-${Date.now()}-${uuidv4()}.tmp`
