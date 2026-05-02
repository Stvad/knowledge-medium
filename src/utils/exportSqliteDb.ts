/**
 * Download a raw `.db` snapshot of the live PowerSync SQLite database.
 *
 * Strategy:
 *   1. `VACUUM INTO 'kmp-export-{ts}.db'` — produces a single, fully-merged
 *      SQLite file in the same wa-sqlite VFS (no WAL, no -shm). The side
 *      file lives in the same IndexedDB DB as the live one (IDBBatchAtomicVFS
 *      keys rows by `path`, sharing one IDB DB across all VFS files).
 *   2. Read the side file's bytes by walking IndexedDB directly: for each
 *      offset, pick the most-recent committed version, place its `data`
 *      bytes at file position `-block.offset`.
 *   3. Drop the side file (delete metadata + blocks rows) so the IDB DB
 *      doesn't accumulate orphan exports.
 *
 * The IDB layout we depend on is IDBBatchAtomicVFS schema v6:
 *   - object store `metadata` keyed by `name` → `{name, fileSize, version}`
 *   - object store `blocks` keyed by `[path, offset, version]` → `{...,data}`
 *     where `offset` is stored *negated* (so smaller key = later in file).
 */

import type { Repo } from '@/data/internals/repo'
import { dbFilenameForUser, getPowerSyncDb } from '@/data/repoProvider'

interface BlockMetadata {
  name: string
  fileSize: number
  version: number
}

interface BlockRow {
  path: string
  offset: number  // negated: file pos = -offset
  version: number
  data: Uint8Array
}

export async function exportRawSqliteDb(repo: Repo): Promise<{ blob: Blob; filename: string }> {
  const userId = repo.user.id
  const liveDb = getPowerSyncDb(userId)
  const liveDbFilename = dbFilenameForUser(userId)

  const ts = Date.now()
  const exportName = `kmp-export-${ts}.db`
  // wa-sqlite stores VFS paths with a leading slash, so look them up
  // by `/${name}` even though VACUUM INTO takes the bare filename.
  const exportVfsPath = `/${exportName}`

  // VACUUM INTO requires a string literal; exportName is fully controlled
  // (digits + fixed prefix/suffix), so direct interpolation is safe.
  await liveDb.execute(`VACUUM INTO '${exportName}'`)

  try {
    const bytes = await readVfsFile(liveDbFilename, exportVfsPath)
    const downloadFilename = `${liveDbFilename.replace(/\.db$/, '')}-export-${ts}.db`
    return {
      blob: new Blob([bytes], {type: 'application/vnd.sqlite3'}),
      filename: downloadFilename,
    }
  } finally {
    await deleteVfsFile(liveDbFilename, exportVfsPath).catch(err => {
      console.warn('[export-db] failed to drop side file', exportVfsPath, err)
    })
  }
}

async function readVfsFile(idbName: string, vfsPath: string): Promise<Uint8Array> {
  const idb = await openIdb(idbName)
  try {
    const tx = idb.transaction(['metadata', 'blocks'], 'readonly')
    const metaStore = tx.objectStore('metadata')
    const blocksStore = tx.objectStore('blocks')

    const metadata = await reqToPromise<BlockMetadata | undefined>(metaStore.get(vfsPath))
    if (!metadata) throw new Error(`No VFS metadata for ${vfsPath}`)
    const fileSize = metadata.fileSize
    const out = new Uint8Array(fileSize)

    // Iterate blocks for this path, smallest-key first. For a given offset,
    // multiple versions may exist; smaller version = more recent (versions
    // monotonically decrement). Take the first hit per offset.
    const seenOffsets = new Set<number>()
    await new Promise<void>((resolve, reject) => {
      const cursorReq = blocksStore.openCursor(
        IDBKeyRange.bound(
          [vfsPath, -Infinity, -Infinity],
          [vfsPath, 0, Infinity],
        ),
        'next',
      )
      cursorReq.onsuccess = () => {
        const cursor = cursorReq.result
        if (!cursor) { resolve(); return }
        const block = cursor.value as BlockRow
        if (!seenOffsets.has(block.offset)) {
          seenOffsets.add(block.offset)
          const fileStart = -block.offset
          if (fileStart < fileSize) {
            const len = Math.min(block.data.byteLength, fileSize - fileStart)
            if (len > 0) out.set(block.data.subarray(0, len), fileStart)
          }
        }
        cursor.continue()
      }
      cursorReq.onerror = () => reject(cursorReq.error)
    })

    return out
  } finally {
    idb.close()
  }
}

async function deleteVfsFile(idbName: string, vfsPath: string): Promise<void> {
  const idb = await openIdb(idbName)
  try {
    await new Promise<void>((resolve, reject) => {
      const tx = idb.transaction(['metadata', 'blocks'], 'readwrite')
      tx.objectStore('metadata').delete(vfsPath)
      tx.objectStore('blocks').delete(IDBKeyRange.bound(
        [vfsPath, -Infinity, -Infinity],
        [vfsPath, Infinity, Infinity],
      ))
      tx.oncomplete = () => resolve()
      tx.onerror = () => reject(tx.error)
      tx.onabort = () => reject(tx.error)
    })
  } finally {
    idb.close()
  }
}

function openIdb(name: string): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(name)
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error)
    req.onblocked = () => reject(new Error(`IDB open blocked for ${name}`))
  })
}

function reqToPromise<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error)
  })
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
