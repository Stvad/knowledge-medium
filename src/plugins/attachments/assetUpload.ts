/** The browser's attachments lanes, cached per user. Capture uses the repo's own
 *  user, and background uploads share a per-user Web Lock across tabs. */

import { getActiveUserId, isRemoteSyncActive, syncResolverForUser } from '@/data/repoProvider.js'
import type { Repo } from '@/data/repo.js'
import { fetchWorkspaceConversionState } from '@/data/workspaceConversion.js'
import { supabase } from '@/services/supabase.js'
import { showError } from '@/utils/toast.js'
import { withLock } from '@/utils/webLock.js'
import { createSupabaseBlobStore, NO_REMOTE_BLOB_STORE, type BlobStore } from './blobStore.js'
import { getByteStore } from './byteStore.js'
import { CAPTURE_FAILURE_MESSAGE, type MediaCaptureDeps, type MediaCaptureResult } from './mediaCapture.js'
import { createMediaLanes, type MediaLanes } from './mediaLanes.js'
import { refreshUploadLaneStatus } from './uploadLaneStatus.js'
import { getByteUploadStore } from './uploadStore.js'

/** The PUT and recovery probe share the same live-session check. Without a
 *  token, recovery cannot distinguish an absent object from an RLS denial. */
const getSupabaseAccessToken = async (): Promise<string | null> =>
  supabase ? ((await supabase.auth.getSession()).data.session?.access_token ?? null) : null

let blobStoreSingleton: BlobStore | null = null
const configuredBlobStore = (): BlobStore => (blobStoreSingleton ??= supabase
  ? createSupabaseBlobStore({ client: supabase, getAccessToken: getSupabaseAccessToken })
  : NO_REMOTE_BLOB_STORE)

/** Check the live session on each call, including operations on a cached store. */
export const remoteSyncGated = (remote: BlobStore, canUseRemote = isRemoteSyncActive): BlobStore => ({
  put: (ws, key, bytes) => (canUseRemote() ? remote : NO_REMOTE_BLOB_STORE).put(ws, key, bytes),
  get: (ws, key) => (canUseRemote() ? remote : NO_REMOTE_BLOB_STORE).get(ws, key),
  probe: (ws, key) => (canUseRemote() ? remote : NO_REMOTE_BLOB_STORE).probe(ws, key),
  delete: (ws, key, signal) => (canUseRemote() ? remote : NO_REMOTE_BLOB_STORE).delete(ws, key, signal),
})

const hasRemoteSync = () => supabase !== null && isRemoteSyncActive()

/** The browser blob store when remote sync is enabled, or null in local-only mode. */
export const getBlobStore = (): BlobStore | null =>
  hasRemoteSync() ? remoteSyncGated(configuredBlobStore()) : null

const lanesByUser = new Map<string, MediaLanes>()

export const getMediaLanesForUser = (userId: string): MediaLanes => {
  const cached = lanesByUser.get(userId)
  if (cached) return cached
  const uploadStore = getByteUploadStore()
  const canDrain = () => hasRemoteSync() && getActiveUserId() === userId
  const lanes = createMediaLanes({
    userId,
    byteStore: getByteStore(),
    uploadStore,
    blobStore: remoteSyncGated(configuredBlobStore(), canDrain),
    keys: syncResolverForUser(userId),
    readLiveWorkspace: fetchWorkspaceConversionState,
    canDrain,
    exclusive: work => withLock(`km-asset-upload-lane:${userId}`, work),
    afterPass: () => refreshUploadLaneStatus(uploadStore, userId),
  })
  lanesByUser.set(userId, lanes)
  return lanes
}

/** Arm the bound user's background drain. */
export const armUploadDrain = (userId: string): void => {
  void getMediaLanesForUser(userId).drain()
}

/** Surface existing failures even in local-only mode. With remote sync on,
 *  promote recoverable staged records and arm the drain in the background. */
export const runUploadReconcile = async (userId: string, repo: Repo): Promise<void> => {
  await refreshUploadLaneStatus(getByteUploadStore(), userId)
  if (!hasRemoteSync()) return
  const lanes = getMediaLanesForUser(userId)
  await lanes.reconcile(repo)
  void lanes.drain()
}

/** Retry failed records and drain under one per-user lock. */
export const runUploadRecovery = (userId: string): Promise<void> =>
  getMediaLanesForUser(userId).recover(getSupabaseAccessToken)

/** Capture into the workspace's ASSETS container using the repo's account. */
export const captureMediaFromFiles = async (
  repo: Repo,
  workspaceId: string,
  files: readonly File[],
  options: Pick<MediaCaptureDeps, 'txDescription'> = {},
): Promise<MediaCaptureResult[]> => {
  const userId = repo.user.id
  if (!userId) return files.map(() => ({ ok: false, reason: 'no-user' as const }))
  return getMediaLanesForUser(userId).capture(repo, workspaceId, files, options)
}

/** Toast the distinct failure reasons from a (possibly multi-file) capture. Call on
 *  the resolved results of {@link captureMediaFromFiles} so a silently-rejected paste
 *  becomes visible feedback. De-dupes identical reasons across files. */
export const reportCaptureFailures = (results: readonly MediaCaptureResult[]): void => {
  const reasons = new Set(results.flatMap(r => (r.ok ? [] : [r.reason])))
  for (const reason of reasons) showError(CAPTURE_FAILURE_MESSAGE[reason])
}
