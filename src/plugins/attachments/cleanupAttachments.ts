/**
 * The owner's **Clean up attachments** gesture (docs/workspace-e2ee-conversion.md
 * §6.3 step 8): the attachment cleaner run on its own, on an e2ee workspace the
 * owner has unlocked, with no recovery bundle. It converts raw objects an older
 * client left behind and reports everything else; with no bundle it deletes no
 * object it can't identify. The conversion flow runs the same pass, through
 * `attachmentCleanerIOVerb`.
 */

import { Sparkles } from 'lucide-react'
import { isRemoteSyncActive } from '@/data/repoProvider.js'
import type { Repo } from '@/data/repo.js'
import { fetchWorkspaceConversionState } from '@/data/workspaceConversion.js'
import { ActionContextTypes, type ActionConfig } from '@/shortcuts/types.js'
import {
  attachmentCleanerLockName,
  cleanAttachments,
  type CleanerProgress,
  type CleanerReport,
} from '@/sync/conversion/attachmentCleaner.js'
import type { WorkspaceObjectKeys } from '@/sync/crypto/contentKey.js'
import { getWorkspaceKeyStore, objectKeysOf } from '@/sync/keys/keyStore.js'
import { openDialog } from '@/utils/dialogs.js'
import { stoppable } from '@/utils/untilStopped.js'
import { showError } from '@/utils/toast.js'
import { cleanerIOFor } from './cleanerIO.js'
import { CleanupAttachmentsDialog } from './CleanupAttachmentsDialog.js'
import { runSingleOwner } from './laneLock.js'

export const CLEANUP_ATTACHMENTS_ACTION_ID = 'attachments.cleanup'

interface CleanupContext {
  readonly keys: WorkspaceObjectKeys
  readonly canary: string
}

/** Everything the gesture needs, read now, or why it can't run. Read once
 *  before offering the dialog and again inside the lock, since the dialog can
 *  stay open across a re-key or the start of a conversion. */
const readCleanupContext = async (userId: string, workspaceId: string): Promise<CleanupContext | string> => {
  if (!isRemoteSyncActive()) return 'Attachments need remote sync, which is off.'
  const read = await fetchWorkspaceConversionState(workspaceId)
  if (read.kind !== 'read') return 'Could not read the workspace from the server. Try again when online.'
  const {state} = read
  if (state.ownerUserId !== userId) return 'Only the workspace owner can clean up its attachments.'
  if (state.encryptionMode !== 'e2ee' || !state.wkCanary) return 'Only an end-to-end encrypted workspace has attachments to clean up.'
  if (state.conversionPhase !== null) return 'This workspace is being converted; the conversion cleans up its attachments itself.'
  // One read, so the key and K_id come from the same record.
  const record = await getWorkspaceKeyStore().get(userId, workspaceId)
  const keys = record && objectKeysOf(record)
  if (!keys) return 'Unlock the workspace with its key first.'
  return {keys, canary: state.wkCanary}
}

export type CleanupRun = (
  onProgress: (progress: CleanerProgress) => void,
  signal: AbortSignal,
) => Promise<CleanerReport | 'busy'>

/** The gesture's run, or why it can't be offered. */
export const prepareCleanup = async (repo: Repo, workspaceId: string): Promise<CleanupRun | string> => {
  const userId = repo.user.id
  if (!userId) return 'Sign in to clean up attachments.'
  const first = await readCleanupContext(userId, workspaceId)
  if (typeof first === 'string') return first
  const io = cleanerIOFor(repo, workspaceId)
  if (io.kind === 'unavailable') return `Attachments can't be cleaned up: ${io.reason}.`
  return async (onProgress, signal) => {
    let report: CleanerReport | undefined
    const ran = await runSingleOwner(attachmentCleanerLockName(userId, workspaceId), async () => {
      const context = await readCleanupContext(userId, workspaceId)
      if (typeof context === 'string') throw new Error(context)
      report = await cleanAttachments({workspaceId, io: stoppable(io.io, signal), ...context, bundle: null, signal, onProgress})
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
