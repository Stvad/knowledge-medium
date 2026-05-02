/**
 * Download a raw `.db` snapshot of the live PowerSync SQLite database.
 *
 * With OPFSCoopSyncVFS the database is a real file at OPFS root, so we
 * just read it directly. The journal mode is rollback (`delete`) — see
 * the WAL note in repoProvider.ts — so the .db file is the
 * authoritative state and nothing has to be checkpointed first.
 */

import type { Repo } from '@/data/internals/repo'
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
