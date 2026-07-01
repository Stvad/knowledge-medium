/**
 * The §9 explicit-user-retry surface: a global action the failed-uploads diagnostics
 * warning ({@link import('./uploadLaneStatus.js')}) points its "Retry" button at, and
 * that the command palette lists. It force-runs the recovery actor over the active
 * user's `failed` records — `bypassBound: true` skips the automatic per-record re-drive
 * bound, because the user explicitly asked (design §9: an explicit retry is one of the
 * four recovery triggers, alongside app-start / reconnect / the slow periodic sweep). It
 * does NOT coalesce (uses the queuing lock) — the user's Retry must actually run, not be
 * skipped because a background sweep happens to own the lane.
 *
 * Lives here (not core) so it only exists when the attachments plugin does, like the
 * image-insert actions.
 */
import { RefreshCw } from 'lucide-react'
import { getActiveUserId } from '@/data/repoProvider.js'
import { ActionContextTypes, type ActionConfig } from '@/shortcuts/types.js'
import { runUploadRecovery } from './assetUpload.js'
import { RETRY_UPLOADS_ACTION_ID } from './uploadLaneStatus.js'

export const retryFailedUploadsAction: ActionConfig<typeof ActionContextTypes.GLOBAL> = {
  id: RETRY_UPLOADS_ACTION_ID,
  description: 'Retry failed media uploads',
  context: ActionContextTypes.GLOBAL,
  icon: RefreshCw,
  handler: () => {
    const userId = getActiveUserId()
    if (userId) runUploadRecovery(userId, { bypassBound: true })
  },
}
