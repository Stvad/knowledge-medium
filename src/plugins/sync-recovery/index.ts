/**
 * Sync-recovery plugin — contributes the single `sync.reconnect` action (see
 * ./action.ts for what it does and why). `essential: true` because it's the
 * manual/agent-bridge handle for the same primitive the automatic stall
 * watchdog uses (`reconnectPowerSync` in repoProvider.ts): disabling it via
 * extension settings would remove the one on-demand recovery lever the
 * 2026-08-13 incident showed didn't otherwise exist, right when it might be
 * needed to test recovery on a remote device.
 */
import type { AppExtension } from '@/facets/facet.js'
import { systemToggle } from '@/facets/togglable.js'
import { actionsFacet } from '@/extensions/core.js'
import { syncReconnectAction } from './action.ts'

export { SYNC_RECONNECT_ACTION_ID, syncReconnectAction } from './action.ts'

export const syncRecoveryPlugin: AppExtension = systemToggle({
  id: 'system:sync-recovery',
  name: 'Sync recovery',
  description: 'Adds a command to force-reconnect sync — recovers a stalled upload queue.',
  essential: true,
}).of([
  actionsFacet.of(syncReconnectAction, { source: 'sync-recovery' }),
])
