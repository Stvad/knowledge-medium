/**
 * The owner's **Clean up attachments** gesture (docs/workspace-e2ee-conversion.md
 * §6.3 step 8): the attachment cleaner run on its own, on an e2ee workspace the
 * owner has unlocked, with no recovery bundle. It converts raw objects an older
 * client left behind and reports everything else; with no bundle it deletes no
 * object it can't identify. The conversion flow runs the same pass, through
 * {@link attachmentCleanerIOVerb}.
 */

import { Sparkles } from 'lucide-react'
import { attachmentCleanerIOVerb } from '@/data/attachmentCleanerIOVerb.js'
import { syncResolverForUser } from '@/data/repoProvider.js'
import type { Repo } from '@/data/repo.js'
import { fetchWorkspaceConversionState } from '@/data/workspaceConversion.js'
import { supabase } from '@/services/supabase.js'
import { ActionContextTypes, type ActionConfig } from '@/shortcuts/types.js'
import {
  cleanAttachments,
  type AttachmentCleanerIO,
  type CleanerProgress,
  type CleanerReport,
} from '@/sync/conversion/attachmentCleaner.js'
import { getWorkspaceKeyStore } from '@/sync/keys/keyStore.js'
import { openDialog } from '@/utils/dialogs.js'
import { showError } from '@/utils/toast.js'
import { getBlobStore } from './assetUpload.js'
import { createAttachmentCleanerIO } from './attachmentCleanerIO.js'
import { getByteStore } from './byteStore.js'
import { CleanupAttachmentsDialog } from './CleanupAttachmentsDialog.js'
import { runSingleOwner } from './laneLock.js'

export const CLEANUP_ATTACHMENTS_ACTION_ID = 'attachments.cleanup'

const cleanerIOFor = (repo: Repo, workspaceId: string): AttachmentCleanerIO | null => {
  const userId = repo.user.id
  const blobStore = getBlobStore()
  if (!userId || !supabase || !blobStore) return null
  const resolver = syncResolverForUser(userId)
  return createAttachmentCleanerIO({
    client: supabase,
    blobStore,
    byteStore: getByteStore(),
    repo,
    userId,
    workspaceId,
    getContentKeyHmac: () => resolver?.getContentKeyHmac(workspaceId) ?? Promise.resolve(null),
  })
}

export const attachmentCleanerIOContribution = attachmentCleanerIOVerb.impl(
  ({repo, workspaceId}) => cleanerIOFor(repo, workspaceId),
  {source: 'attachments'},
)

/** One run per (user, workspace) across tabs. */
const cleanerLockName = (userId: string, workspaceId: string) => `km-attachment-cleaner:${userId}:${workspaceId}`

export type CleanupRun = (
  onProgress: (progress: CleanerProgress) => void,
  signal: AbortSignal,
) => Promise<CleanerReport | 'busy'>

/** Everything the gesture checks before it offers to run, or why it can't. */
export const prepareCleanup = async (repo: Repo, workspaceId: string): Promise<CleanupRun | string> => {
  const userId = repo.user.id
  if (!userId) return 'Sign in to clean up attachments.'
  const read = await fetchWorkspaceConversionState(workspaceId)
  if (read.kind !== 'read') return 'Could not read the workspace from the server. Try again when online.'
  const {state} = read
  if (state.ownerUserId !== userId) return 'Only the workspace owner can clean up its attachments.'
  if (state.encryptionMode !== 'e2ee' || !state.wkCanary) return 'Only an end-to-end encrypted workspace has attachments to clean up.'
  const canary = state.wkCanary
  // One read, so the key and K_id come from the same record.
  const record = await getWorkspaceKeyStore().get(userId, workspaceId)
  if (!record?.contentKeyHmac) return 'Unlock the workspace with its key first.'
  const keys = {cek: record.wk, contentKeyHmac: record.contentKeyHmac}
  const io = cleanerIOFor(repo, workspaceId)
  if (!io) return 'Attachments need remote sync.'
  return async (onProgress, signal) => {
    let report: CleanerReport | undefined
    const ran = await runSingleOwner(cleanerLockName(userId, workspaceId), async () => {
      report = await cleanAttachments({workspaceId, io, keys, canary, bundle: null, signal, onProgress})
    })
    return ran && report ? report : 'busy'
  }
}

export const cleanupAttachmentsAction: ActionConfig<typeof ActionContextTypes.GLOBAL> = {
  id: CLEANUP_ATTACHMENTS_ACTION_ID,
  description: 'Clean up attachments (convert plaintext uploads in an encrypted workspace)',
  context: ActionContextTypes.GLOBAL,
  icon: Sparkles,
  handler: ({uiStateBlock}) => {
    const repo = uiStateBlock.repo
    const workspaceId = repo.activeWorkspaceId
    if (!workspaceId) return
    void (async () => {
      const run = await prepareCleanup(repo, workspaceId)
      if (typeof run === 'string') {
        showError(run)
        return
      }
      await openDialog(CleanupAttachmentsDialog, {run})
    })().catch((error: unknown) => {
      showError(error instanceof Error ? error.message : 'Attachment cleanup failed')
    })
  },
}
