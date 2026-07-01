/**
 * The §9 explicit-user-retry surface: a global action the failed-uploads diagnostics
 * warning ({@link import('./uploadLaneStatus.js')}) points its "Retry" button at, and
 * that the command palette lists. It force-runs the recovery actor over the active
 * user's `failed` records with an UNCAPPED re-drive (`maxRecoveryAttempts: Infinity`) —
 * the user explicitly asked, so never give up on their command (design §9: an explicit
 * retry is one of the four recovery triggers, alongside app-start / reconnect / the slow
 * periodic sweep). It does NOT coalesce (uses the queuing lock) — the user's Retry must
 * actually run, not be skipped because a background sweep happens to own the lane.
 *
 * A single in-flight guard debounces the button: without it, N rapid clicks queue N full
 * passes, each re-PUTting a shape-rejected body's sealed bytes (the uncapped path bypasses
 * the automatic cap on purpose). One retry runs at a time; clicks while it's in flight are
 * ignored until it settles.
 *
 * Lives here (not core) so it only exists when the attachments plugin does, like the
 * image-insert actions.
 */
import { RefreshCw } from 'lucide-react'
import { getActiveUserId } from '@/data/repoProvider.js'
import { ActionContextTypes, type ActionConfig } from '@/shortcuts/types.js'
import { runUploadRecovery } from './assetUpload.js'
import { RETRY_UPLOADS_ACTION_ID } from './uploadLaneStatus.js'

let retryInFlight: Promise<void> | null = null

export const retryFailedUploadsAction: ActionConfig<typeof ActionContextTypes.GLOBAL> = {
  id: RETRY_UPLOADS_ACTION_ID,
  description: 'Retry failed media uploads',
  context: ActionContextTypes.GLOBAL,
  icon: RefreshCw,
  handler: () => {
    const userId = getActiveUserId()
    if (!userId || retryInFlight) return // one retry at a time — swallow double-clicks
    retryInFlight = runUploadRecovery(userId, { maxRecoveryAttempts: Number.POSITIVE_INFINITY })
    void retryInFlight.finally(() => {
      retryInFlight = null
    })
  },
}
