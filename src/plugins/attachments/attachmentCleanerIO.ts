/**
 * The attachment cleaner's view of one workspace ({@link AttachmentCleanerIO}),
 * over this plugin's Storage, byte store and media blocks. The pass itself is
 * core (`src/sync/conversion/attachmentCleaner.ts`); the conversion flow reaches
 * this through {@link attachmentCleanerIOVerb}, the owner gesture directly.
 */

import type { SupabaseClient } from '@supabase/supabase-js'
import type { Repo } from '@/data/repo.js'
import type { AttachmentCleanerIO, ObjectPath } from '@/sync/conversion/attachmentCleaner.js'
import { ATTACHMENTS_BUCKET, BlobPutError, type BlobStore } from './blobStore.js'
import type { ByteStore } from './byteStore.js'
import { MEDIA_TYPE, mediaHashOf } from './mediaBlock.js'
import { deriveObjectKey } from './storagePaths.js'

const LIST_PAGE = 1000

/** Every object under `<workspaceId>/`, relative to it. Storage's list returns
 *  the entries directly under a prefix, a nested folder as an entry with no id,
 *  so each folder is listed in turn. The pass acts only after this returns, so
 *  offset paging sees a folder no one is writing. */
export const listWorkspaceObjects = async (client: SupabaseClient, workspaceId: string): Promise<ObjectPath[]> => {
  const out: ObjectPath[] = []
  const folders: string[] = ['']
  for (let folder = folders.pop(); folder !== undefined; folder = folders.pop()) {
    for (let offset = 0; ; offset += LIST_PAGE) {
      const {data, error} = await client.storage
        .from(ATTACHMENTS_BUCKET)
        .list(folder ? `${workspaceId}/${folder}` : workspaceId, {
          limit: LIST_PAGE,
          offset,
          sortBy: {column: 'name', order: 'asc'},
        })
      if (error) throw error
      for (const entry of data) {
        const path = folder ? `${folder}/${entry.name}` : entry.name
        if (entry.id === null) folders.push(path)
        else out.push(path)
      }
      if (data.length < LIST_PAGE) break
    }
  }
  return out.sort()
}

/** Every media block of the workspace, soft-deleted ones included: the typed
 *  query skips deleted rows, and a deleted block's attachment must still be
 *  converted and kept. */
export const listMediaBlocks = async (
  repo: Repo,
  workspaceId: string,
): Promise<{blockId: string; contentHash: string}[]> => {
  const rows = await repo.db.getAll<{id: string; properties_json: string}>(
    `SELECT b.id, b.properties_json FROM blocks b
     WHERE b.workspace_id = ?
       AND EXISTS (SELECT 1 FROM json_each(b.properties_json, '$.types') t WHERE t.value = ?)`,
    [workspaceId, MEDIA_TYPE],
  )
  return rows.flatMap(row => {
    let properties: Record<string, unknown>
    try {
      properties = JSON.parse(row.properties_json) as Record<string, unknown>
    } catch {
      return []
    }
    const contentHash = mediaHashOf(properties)
    return contentHash ? [{blockId: row.id, contentHash}] : []
  })
}

export interface AttachmentCleanerIODeps {
  readonly client: SupabaseClient
  readonly blobStore: BlobStore
  readonly byteStore: ByteStore
  readonly repo: Repo
  readonly userId: string
  readonly workspaceId: string
  readonly getContentKeyHmac: () => Promise<CryptoKey | null>
}

export const createAttachmentCleanerIO = (deps: AttachmentCleanerIODeps): AttachmentCleanerIO => {
  const {blobStore, byteStore, userId, workspaceId} = deps
  return {
    listObjects: () => listWorkspaceObjects(deps.client, workspaceId),
    readObject: path => blobStore.probe(workspaceId, path),
    async writeObject(path, bytes) {
      try {
        return {kind: await blobStore.put(workspaceId, path, bytes)}
      } catch (err) {
        if (err instanceof BlobPutError && err.permanent) return {kind: 'refused', status: err.status}
        throw err
      }
    },
    deleteObject: path => blobStore.delete(workspaceId, path),
    mediaBlocks: () => listMediaBlocks(deps.repo, workspaceId),
    async localBytes(contentHash) {
      const key = await deriveObjectKey(contentHash, 'e2ee', deps.getContentKeyHmac)
      if (!key.ok) return null
      for (const name of key.localKeys) {
        const bytes = await byteStore.get(userId, workspaceId, name)
        if (bytes) return bytes
      }
      return null
    },
  }
}
