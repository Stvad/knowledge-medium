/**
 * The attachment cleaner's view of one workspace ({@link AttachmentCleanerIO}),
 * over this plugin's Storage, byte store and media blocks. The pass itself is
 * core (`src/sync/conversion/attachmentCleaner.ts`); the conversion flow reaches
 * this through `attachmentCleanerIOVerb`, the owner gesture directly.
 */

import type { SupabaseClient } from '@supabase/supabase-js'
import type { Repo } from '@/data/repo.js'
import type { AttachmentCleanerIO, MediaRef, ObjectPath } from '@/sync/conversion/attachmentCleaner.js'
import { ATTACHMENTS_BUCKET, BlobPutError, type BlobStore } from './blobStore.js'
import type { ByteStore } from './byteStore.js'
import { MEDIA_TYPE, mediaHashOf } from './mediaBlock.js'

const LIST_PAGE = 1000

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
 * compares names bytewise. The pass acts only after this returns.
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
  const prefix = `${workspaceId}/`
  const out: ObjectPath[] = []
  for (let cursor: string | undefined, more = true; more; ) {
    signal?.throwIfAborted()
    assertRemote()
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
    const contentHash = mediaHashOf(JSON.parse(row.properties_json) as Record<string, unknown>)
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
  readonly isRemoteSyncActive: () => boolean
}

export const createAttachmentCleanerIO = (deps: AttachmentCleanerIODeps): AttachmentCleanerIO => {
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
  }
}
