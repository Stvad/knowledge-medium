/**
 * `sync.reconnect` — force PowerSync to disconnect + reconnect for the
 * active user. This is the SUPPORTED way to re-trigger `uploadData` on
 * demand (PowerSync has no public "drain the crud queue now" API) and it
 * forces a fresh `fetchCredentials`, so the same lever covers a stale-token
 * stall too. See `reconnectPowerSync` in `@/data/repoProvider.ts` for the
 * actual disconnect/connect + serialization through the shared connect
 * chain — this is a thin action wrapper around that primitive.
 *
 * A normal global action so it's reachable from BOTH the command palette
 * and the agent bridge (`kmagent run-action sync.reconnect`) — the bridge
 * path matters because the 2026-08-13 iPad incident had no way to test a
 * recovery lever on the remote device at all. No dedicated UI beyond those
 * two generic reachability paths (a status-chip button was considered and
 * dropped) — the AUTOMATIC lever is the sync-stall watchdog
 * (`src/utils/dbForensicsHooks.ts`), which calls `reconnectPowerSync`
 * directly rather than going through this action.
 */
import { RefreshCw } from 'lucide-react'
import { ActionContextTypes, type ActionConfig } from '@/shortcuts/types.js'
import { reconnectPowerSync } from '@/data/repoProvider.js'

export const SYNC_RECONNECT_ACTION_ID = 'sync.reconnect'

export const syncReconnectAction: ActionConfig<typeof ActionContextTypes.GLOBAL> = {
  id: SYNC_RECONNECT_ACTION_ID,
  description: 'Reconnect sync (recover a stalled upload queue)',
  context: ActionContextTypes.GLOBAL,
  icon: RefreshCw,
  handler: async ({ uiStateBlock }) => {
    await reconnectPowerSync(uiStateBlock.repo.user.id)
  },
}
