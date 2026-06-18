import {
  actionsFacet,
  appEffectsFacet,
  type AppEffect,
} from '@/extensions/core.js'
import type { AppExtension } from '@/facets/facet.js'
import { dialogAppMountExtension } from '@/extensions/dialogAppMount.js'
import { systemToggle } from '@/facets/togglable.js'
import { ActionContextTypes, type ActionConfig } from '@/shortcuts/types.js'
import { openDialog } from '@/utils/dialogs.js'
import { AgentTokensDialog } from './AgentTokensDialog.tsx'
import { agentRuntimeBridgeRestartEvent, startAgentRuntimeBridge } from './bridge.ts'

export { agentRuntimeBridgeRestartEvent } from './bridge.ts'

export const agentRuntimeBridgeEffect: AppEffect = {
  id: 'agent-runtime.bridge',
  start: startAgentRuntimeBridge,
}

export const restartAgentRuntimeBridgeAction: ActionConfig<typeof ActionContextTypes.GLOBAL> = {
  id: 'restart_agent_runtime_bridge',
  description: 'Restart agent runtime bridge',
  context: ActionContextTypes.GLOBAL,
  // Genuine broadcast to the running bridge effect (not a dialog/mount):
  // the poll loop listens for this to wake and re-register.
  handler: () => {
    // eslint-disable-next-line no-restricted-syntax -- genuine broadcast: wakes the running bridge poll loop
    window.dispatchEvent(new CustomEvent(agentRuntimeBridgeRestartEvent))
  },
}

export const manageAgentTokensAction: ActionConfig<typeof ActionContextTypes.GLOBAL> = {
  id: 'manage_agent_tokens',
  description: 'Manage agent runtime tokens',
  context: ActionContextTypes.GLOBAL,
  handler: () => {
    void openDialog(AgentTokensDialog)
  },
}

export const agentRuntimePlugin: AppExtension = systemToggle({
  id: 'system:agent-runtime',
  name: 'Agent runtime',
  description: 'Bridge that lets external agents drive the app through a typed command protocol (also exposes per-token management UI).',
}).of([
  // The tokens dialog opens via `openDialog`; pull DialogHost in
  // (deduped by reference).
  dialogAppMountExtension,
  appEffectsFacet.of(agentRuntimeBridgeEffect, {source: 'agent-runtime'}),
  actionsFacet.of(restartAgentRuntimeBridgeAction, {source: 'agent-runtime'}),
  actionsFacet.of(manageAgentTokensAction, {source: 'agent-runtime'}),
])

export default agentRuntimePlugin
