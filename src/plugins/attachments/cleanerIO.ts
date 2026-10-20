import type { AttachmentCleanerIOResult } from '@/data/attachmentCleanerIOVerb.js'
import type { Repo } from '@/data/repo.js'
import { isRemoteSyncActive } from '@/data/repoProvider.js'
import { supabase } from '@/services/supabase.js'
import { buildBlobStore } from './assetResolver.js'
import { createAttachmentCleanerIO } from './attachmentCleanerIO.js'
import { getByteStore } from './byteStore.js'
import { getByteUploadStore } from './uploadStore.js'

/** The cleaner's view of one workspace's Storage folder and this device's
 *  copies, or why there is none. */
export const cleanerIOFor = (repo: Repo, workspaceId: string): AttachmentCleanerIOResult => {
  const userId = repo.user.id
  if (!userId) return {kind: 'unavailable', reason: 'no one is signed in'}
  if (!supabase || !isRemoteSyncActive()) return {kind: 'unavailable', reason: 'remote sync is off'}
  return {
    kind: 'ready',
    io: createAttachmentCleanerIO({
      client: supabase,
      blobStore: buildBlobStore(),
      byteStore: getByteStore(),
      uploadStore: getByteUploadStore(),
      repo,
      userId,
      workspaceId,
      isRemoteSyncActive,
    }),
  }
}
