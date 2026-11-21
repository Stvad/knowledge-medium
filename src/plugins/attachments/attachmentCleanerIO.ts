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
import { ATTACHMENTS_BUCKET, BlobPutError, type BlobStore } from './blobStore.js'
import type { ByteStore } from './byteStore.js'
import { isAssetBlockPresent } from './uploadReconcile.js'
import type { ByteUploadStore } from './uploadStore.js'
import { MEDIA_TYPE, mediaHashOfStoredRow } from './mediaBlock.js'

const LIST_PAGE = 1000

/** Before every Storage request, not once: local-only mode can begin mid-run. */
const assertRemote = (isRemoteSyncActive: () => boolean) => {
  if (!isRemoteSyncActive()) throw new Error('attachments: remote sync is off')
}

export interface ListWorkspaceObjectsInput {
  readonly client: SupabaseClient
  readonly userId: string
  readonly workspaceId: string
  readonly isRemoteSyncActive: () => boolean
  readonly signal?: AbortSignal
}

/**
 * Every object under `<workspaceId>/`, relative to it: one flat listing of the
 * folder by full name, nested objects included, paged by Storage's cursor.
 * Storage's v1 `list()` matches a folder's name case-insensitively, so it lists
 * `Dir/` and `dir/` as one folder whose objects all read as `Dir/…`; v2
 * compares names bytewise.
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
  assertRemote(isRemoteSyncActive)
  const {session} = (await client.auth.getSession()).data
  if (!session || session.user.id !== userId) {
    throw new Error("attachments: the signed-in session is not this account's; sign in again")
  }
  const files = client.storage.from(ATTACHMENTS_BUCKET).setHeader('Authorization', `Bearer ${session.access_token}`)
  const prefix = `${workspaceId}/`
  const out: ObjectPath[] = []
  for (let cursor: string | undefined, more = true; more; ) {
    signal?.throwIfAborted()
    assertRemote(isRemoteSyncActive)
    const {data, error} = await files.listV2({prefix, cursor, limit: LIST_PAGE}, {signal})
    if (error) throw error
    // Without a delimiter `name` is the object's full name. Defence in depth:
    // a Storage that named them otherwise would have paths cut out of them.
    for (const {name} of data.objects) {
      if (!name.startsWith(prefix)) throw new Error(`attachments: Storage listed ${name} under ${prefix}`)
      out.push(name.slice(prefix.length))
    }
    more = data.hasNext
    // Defence in depth: a next page with no cursor would start the listing over.
    // Accepted: a line break in a name can corrupt the cursor, and only a direct
    // database write makes such a name.
    if (more && !data.nextCursor) throw new Error(`attachments: Storage gave no cursor for the next page of ${prefix}`)
    cursor = data.nextCursor
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

/** The attachments bucket's own upload limit in bytes, or null when it has
 *  none and only the project-wide limit, which a client can't read, applies.
 *  Signed-in users may read the bucket's row; anyone else is told it doesn't
 *  exist. */
const bucketUploadLimit = async (
  {client, isRemoteSyncActive}: {readonly client: SupabaseClient; readonly isRemoteSyncActive: () => boolean},
): Promise<number | null> => {
  assertRemote(isRemoteSyncActive)
  const {data, error} = await client.storage.getBucket(ATTACHMENTS_BUCKET)
  if (error) throw new Error(`attachments: the bucket's upload limit could not be read: ${error.message}`)
  return data.file_size_limit ?? null
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
    uploadLimit: () => bucketUploadLimit(deps),
    async writeObject(path, bytes) {
      try {
        return {kind: await blobStore.put(workspaceId, path, bytes)}
      } catch (err) {
        if (err instanceof BlobPutError && err.permanent) return {kind: 'refused', status: err.status}
        throw err
      }
    },
    deleteObject: (path, signal) => blobStore.delete(workspaceId, path, signal),
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
      const records = (await Promise.all(statuses.map(status => deps.uploadStore.listByStatus(userId, status))))
        .flat()
        .filter(record => record.workspaceId === workspaceId)
      // A stage whose block isn't here never got one: this device's own capture
      // writes it here. It never uploads and nothing clears it, so counting it
      // would block the conversion for good.
      const uploading = await Promise.all(records.map(record => record.status !== 'staged' || isAssetBlockPresent(repo, record.assetBlockId)))
      return uploading.filter(Boolean).length
    },
  }
}
