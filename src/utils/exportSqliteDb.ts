/**
 * Download / replace the raw `.db` snapshot of the live PowerSync
 * SQLite database.
 *
 * With OPFSCoopSyncVFS the database is a real file at OPFS root, so we
 * just read it directly. The journal mode is rollback (`delete`) — see
 * the WAL note in repoProvider.ts — so the .db file is the
 * authoritative state and nothing has to be checkpointed first.
 *
 * Import is the reverse: close the live PowerSync DB to release the
 * OPFS sync access handle, overwrite the user's .db file with the
 * supplied bytes, then ask the caller to reload so the new file is
 * opened cleanly. The simple "replace whole DB" semantics — same user
 * keeps using the same dbFilename, we just swap what's inside.
 */

import type { Repo } from '../data/repo'
import { dbFilenameForUser } from '@/data/repoProvider'

export async function exportRawSqliteDb(repo: Repo): Promise<{ blob: Blob; filename: string }> {
  const userId = repo.user.id
  const dbFilename = dbFilenameForUser(userId)

  const root = await navigator.storage.getDirectory()
  const fileHandle = await root.getFileHandle(dbFilename)
  const file = await fileHandle.getFile()
  const blob = new Blob([await file.arrayBuffer()], { type: 'application/vnd.sqlite3' })

  const ts = Date.now()
  const downloadFilename = `${dbFilename.replace(/\.db$/, '')}-export-${ts}.db`
  return { blob, filename: downloadFilename }
}

export function downloadBlob(blob: Blob, filename: string): void {
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
  const buffer = await file.arrayBuffer()

  // Cheap header check so a wrong-file selection fails before we
  // tear down the live database.
  if (buffer.byteLength < SQLITE_MAGIC.length) {
    throw new Error('Selected file is too small to be a SQLite database.')
  }
  const head = new Uint8Array(buffer, 0, SQLITE_MAGIC.length)
  for (let i = 0; i < SQLITE_MAGIC.length; i++) {
    if (head[i] !== SQLITE_MAGIC[i]) {
      throw new Error('Selected file is not a SQLite database (missing magic header).')
    }
  }

  const userId = repo.user.id
  const dbFilename = dbFilenameForUser(userId)

  // Release the OPFS sync access handle the worker holds on the .db
  // file; without this, createWritable() throws NoModificationAllowedError.
  await repo.db.close()

  const root = await navigator.storage.getDirectory()

  // Rollback-journal mode normally deletes -journal on clean close and
  // we don't run WAL, but be defensive — a leftover sibling from a
  // crashed prior session would be replayed against the freshly
  // imported DB and silently corrupt it.
  for (const suffix of ['-journal', '-wal']) {
    try {
      await root.removeEntry(dbFilename + suffix)
    } catch (err) {
      if (!(err instanceof DOMException && err.name === 'NotFoundError')) {
        throw err
      }
    }
  }

  const fileHandle = await root.getFileHandle(dbFilename, { create: true })
  const writable = await fileHandle.createWritable({ keepExistingData: false })
  try {
    await writable.write(buffer)
  } finally {
    await writable.close()
  }
}
