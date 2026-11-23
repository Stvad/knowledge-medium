/** Browser composition for the shared per-user attachment lanes. */

import { getActiveUserId, isRemoteSyncActive, syncResolverForUser } from '@/data/repoProvider.js'
import { fetchWorkspaceConversionState } from '@/data/workspaceConversion.js'
import { supabase } from '@/services/supabase.js'
import { withLock } from '@/utils/webLock.js'
import { createSupabaseBlobStore, NO_REMOTE_BLOB_STORE, sessionAccessToken, type BlobStore } from './blobStore.js'
import { getByteStore } from './byteStore.js'
import { createMediaLanes, type MediaLanes } from './mediaLanes.js'
import { refreshUploadLaneStatus } from './uploadLaneStatus.js'
import { getByteUploadStore } from './uploadStore.js'

const getAccessToken = () => sessionAccessToken(supabase)
let blobStoreSingleton: BlobStore | null = null

/** Check the live session on each call, including operations on a cached store. */
const remoteSyncGated = (remote: BlobStore, canUseRemote: () => boolean): BlobStore => ({
  put: (ws, key, bytes) => (canUseRemote() ? remote : NO_REMOTE_BLOB_STORE).put(ws, key, bytes),
  get: (ws, key) => (canUseRemote() ? remote : NO_REMOTE_BLOB_STORE).get(ws, key),
  probe: (ws, key) => (canUseRemote() ? remote : NO_REMOTE_BLOB_STORE).probe(ws, key),
  delete: (ws, key, signal) => (canUseRemote() ? remote : NO_REMOTE_BLOB_STORE).delete(ws, key, signal),
})

export const hasRemoteSync = (): boolean => supabase !== null && isRemoteSyncActive()

export const buildBlobStore = (canUseRemote = isRemoteSyncActive): BlobStore => {
  if (!supabase) return NO_REMOTE_BLOB_STORE
  blobStoreSingleton ??= createSupabaseBlobStore({ client: supabase, getAccessToken })
  return remoteSyncGated(blobStoreSingleton, canUseRemote)
}

const lanesByUser = new Map<string, MediaLanes>()

export const getMediaLanesForUser = (userId: string): MediaLanes => {
  const cached = lanesByUser.get(userId)
  if (cached) return cached
  const uploadStore = getByteUploadStore()
  const canUseRemote = () => hasRemoteSync() && getActiveUserId() === userId
  const lanes = createMediaLanes({
    userId,
    byteStore: getByteStore(),
    uploadStore,
    blobStore: buildBlobStore(canUseRemote),
    getAccessToken,
    keys: syncResolverForUser(userId),
    readLiveWorkspace: fetchWorkspaceConversionState,
    canDrain: canUseRemote,
    exclusive: work => withLock(`km-asset-upload-lane:${userId}`, work),
    afterPass: () => refreshUploadLaneStatus(uploadStore, userId),
  })
  lanesByUser.set(userId, lanes)
  return lanes
}
