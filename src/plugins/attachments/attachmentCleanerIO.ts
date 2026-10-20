/**
 * One workspace's Storage folder, byte store and media blocks, as the
 * attachment cleaner and the conversion read them ({@link ConversionAttachmentsIO}). The pass itself is
 * core (`src/sync/conversion/attachmentCleaner.ts`); the conversion flow reaches
 * this through `attachmentCleanerIOVerb`, the owner gesture directly.
 */

import type { SupabaseClient } from '@supabase/supabase-js'
import type { Repo } from '@/data/repo.js'
import type { MediaRef, ObjectPath } from '@/sync/conversion/attachmentCleaner.js'
import type { ConversionAttachmentsIO } from '@/sync/conversion/conversionAttachments.js'
import { collectPaged } from './audit/paginate.js'
import { ATTACHMENTS_BUCKET, BlobPutError, type BlobStore } from './blobStore.js'
import type { ByteStore } from './byteStore.js'
import type { ByteUploadStore } from './uploadStore.js'
import { MEDIA_TYPE, mediaHashOfStoredRow } from './mediaBlock.js'

const LIST_PAGE = 1000

export interface ListWorkspaceObjectsInput {
  readonly client: SupabaseClient
  readonly userId: string
  readonly workspaceId: string
  readonly isRemoteSyncActive: () => boolean
  readonly signal?: AbortSignal
}

/**
 * Every object under `<workspaceId>/`, relative to it. Storage's list returns
 * the entries directly under a prefix, a nested folder as an entry with no id,
 * so each folder is listed in turn. The pass acts only after this returns, so
 * offset paging sees a folder no one is writing.
 *
 * RLS filters a listing rather than refusing it: under the anon key (no
 * session) or another user's session the folder reads as empty, which would
 * pass for clean. So the listing runs only under `userId`'s own session, with
 * its token pinned on the request.
 */
export const listWorkspaceObjects = async ({
  client,
  userId,
  workspaceId,
  isRemoteSyncActive,
  signal,
}: ListWorkspaceObjectsInput): Promise<ObjectPath[]> => {
  // Before every request, not once: local-only mode can begin mid-listing.
  const assertRemote = () => {
    if (!isRemoteSyncActive()) throw new Error('attachments: remote sync is off')
  }
  assertRemote()
  const {session} = (await client.auth.getSession()).data
  if (!session || session.user.id !== userId) {
    throw new Error("attachments: the signed-in session is not this account's; sign in again")
  }
  const files = client.storage.from(ATTACHMENTS_BUCKET).setHeader('Authorization', `Bearer ${session.access_token}`)
  const out: ObjectPath[] = []
  const folders: string[] = ['']
  for (let folder = folders.pop(); folder !== undefined; folder = folders.pop()) {
    const prefix = folder ? `${workspaceId}/${folder}` : workspaceId
    const entries = await collectPaged(async offset => {
      signal?.throwIfAborted()
      assertRemote()
      const {data, error} = await files.list(
        prefix,
        {limit: LIST_PAGE, offset, sortBy: {column: 'name', order: 'asc'}},
        {signal},
      )
      if (error) throw error
      return data
    })
    for (const entry of entries) {
      // Only a write from outside the app makes one, and an empty folder name
      // would list this folder again forever.
      if (entry.name === '') throw new Error(`attachments: an object under ${prefix}/ has an empty name segment`)
      const path = folder ? `${folder}/${entry.name}` : entry.name
      if (entry.id === null) folders.push(path)
      else out.push(path)
    }
  }
  return out.sort()
}

/** Every media block of the workspace, soft-deleted ones included: the typed
 *  query skips deleted rows, and a deleted block's attachment must still be
 *  converted and kept. */
export const listMediaBlocks = async (repo: Repo, workspaceId: string): Promise<MediaRef[]> => {
  const rows = await repo.db.getAll<{id: string; properties_json: string}>(
    `SELECT b.id, b.properties_json FROM blocks b
     WHERE b.workspace_id = ?
       AND EXISTS (SELECT 1 FROM json_each(b.properties_json, '$.types') t WHERE t.value = ?)`,
    [workspaceId, MEDIA_TYPE],
  )
  return rows.flatMap(row => {
    const contentHash = mediaHashOfStoredRow(row.properties_json)
    return contentHash ? [{blockId: row.id, contentHash}] : []
  })
}

export interface AttachmentCleanerIODeps {
  readonly client: SupabaseClient
  readonly blobStore: BlobStore
  readonly byteStore: ByteStore
  readonly uploadStore: ByteUploadStore
  readonly repo: Repo
  readonly userId: string
  readonly workspaceId: string
  readonly isRemoteSyncActive: () => boolean
}

export const createAttachmentCleanerIO = (deps: AttachmentCleanerIODeps): ConversionAttachmentsIO => {
  const {blobStore, byteStore, repo, userId, workspaceId} = deps
  return {
    listObjects: signal => listWorkspaceObjects({...deps, signal}),
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
    async mediaBlocks() {
      // A row this device downloaded but has not applied is missing from
      // `blocks`, and its attachment would be missing from the proof.
      const gap = await repo.workspaceViewGap(workspaceId)
      if (gap) throw new Error(`attachments: this device's copy of the workspace is incomplete: ${gap.reason}`)
      return listMediaBlocks(repo, workspaceId)
    },
    readLocal: name => byteStore.get(userId, workspaceId, name),
    writeLocal: (name, bytes) => byteStore.put(userId, workspaceId, name, bytes),
    mediaHashOf: mediaHashOfStoredRow,
    async pendingUploads() {
      const statuses = ['staged', 'pending', 'failed'] as const
      const records = await Promise.all(statuses.map(status => deps.uploadStore.listByStatus(userId, status)))
      return records.flat().filter(record => record.workspaceId === workspaceId).length
    },
  }
}
