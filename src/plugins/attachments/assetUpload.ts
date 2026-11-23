/** Browser entry points for capture, upload, and recovery. */

import type { Repo } from '@/data/repo.js'
import { showError } from '@/utils/toast.js'
import { getMediaLanesForUser, hasRemoteSync } from './browserMedia.js'
import { CAPTURE_FAILURE_MESSAGE, type MediaCaptureDeps, type MediaCaptureResult } from './mediaCapture.js'
import { refreshUploadLaneStatus } from './uploadLaneStatus.js'
import { getByteUploadStore } from './uploadStore.js'

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
  getMediaLanesForUser(userId).recover()

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
