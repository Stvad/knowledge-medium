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

import type { Repo } from '../data/repo'
import { dbFilenameForUser } from '@/data/repoProvider'

export interface RawSqliteDbBlobExport {
  blob: Blob
  filename: string
  cleanup?: () => Promise<void>
}

export interface RawSqliteDbFileExport {
  filename: string
  size: number
}

interface PowerSyncReadLockDb {
  readLock<T>(callback: (db: unknown) => Promise<T>): Promise<T>
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

export function rawSqliteDbExportFilename(repo: Repo, now = Date.now()): string {
  const dbFilename = dbFilenameForUser(repo.user.id)
  return `${dbFilename.replace(/\.db$/, '')}-export-${now}.db`
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
  const size = await withPowerSyncReadLock(repo, async () => {
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
  const snapshotHandle = await root.getFileHandle(snapshotName, {create: true})

  await withPowerSyncReadLock(repo, async () => {
    const sourceFile = await sourceHandle.getFile()
    await pipeBlobToFileHandle(sourceFile, snapshotHandle)
  })

  const blob = await snapshotHandle.getFile()
  return {
    blob,
    filename,
    cleanup: () => removeEntryIfExists(root, snapshotName),
  }
}

export function downloadBlob(
  blob: Blob,
  filename: string,
  cleanup?: () => void | Promise<void>,
): void {
  const url = URL.createObjectURL(blob)
  try {
    const a = document.createElement('a')
    a.href = url
    a.download = filename
    document.body.appendChild(a)
    a.click()
    a.remove()
  } finally {
    // Revoke after the click microtask finishes so the browser has a
    // chance to start the download.
    setTimeout(() => URL.revokeObjectURL(url), 0)
    if (cleanup) {
      // Blob URLs do not expose download completion. This fallback path is
      // only for browsers without showSaveFilePicker; keep the snapshot
      // around long enough for a large download to start and finish.
      setTimeout(() => {
        void Promise.resolve(cleanup()).catch(error => {
          console.warn('[export-db] failed to clean export snapshot:', error)
        })
      }, 60 * 60 * 1000)
    }
  }
}

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
    for (const suffix of ['-journal', '-wal', '-shm']) {
      await removeEntryIfExists(root, dbFilename + suffix)
    }

    const replacement = await stagingHandle.getFile()
    const fileHandle = await root.getFileHandle(dbFilename, {create: true})
    await pipeBlobToFileHandle(replacement, fileHandle)
  } finally {
    await removeEntryIfExists(root, stagingName)
  }
}

const withPowerSyncReadLock = async <T,>(repo: Repo, callback: () => Promise<T>): Promise<T> => {
  const db = repo.db as unknown as Partial<PowerSyncReadLockDb>
  if (typeof db.readLock !== 'function') {
    throw new Error('PowerSync database does not expose readLock; cannot safely snapshot live SQLite DB.')
  }
  return db.readLock(async () => callback())
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

const tempOpfsFilename = (dbFilename: string, purpose: string): string =>
  `.${dbFilename}.${purpose}-${Date.now()}-${randomId()}.tmp`

const randomId = (): string => {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID()
  }
  return Math.random().toString(36).slice(2)
}
