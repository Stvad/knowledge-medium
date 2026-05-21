import {
  actionsFacet,
  appEffectsFacet,
  appMountsFacet,
  type AppEffect,
  type AppMountContribution,
} from '@/extensions/core.ts'
import type { AppExtension } from '@/extensions/facet.ts'
import { withSystemExtensionMetadata } from '@/extensions/togglable.ts'
import { ActionContextTypes, type ActionConfig } from '@/shortcuts/types.ts'
import { AgentTokensDialogMount, openAgentTokensDialogEvent } from './AgentTokensDialog.tsx'
import { agentRuntimeBridgeRestartEvent, startAgentRuntimeBridge } from './bridge.ts'

export { openAgentTokensDialogEvent } from './AgentTokensDialog.tsx'
export { agentRuntimeBridgeRestartEvent } from './bridge.ts'

export const agentRuntimeBridgeEffect: AppEffect = {
  id: 'agent-runtime.bridge',
  start: startAgentRuntimeBridge,
}

export const agentRuntimeTokensDialogMount: AppMountContribution = {
  id: 'agent-runtime.tokens-dialog',
  component: AgentTokensDialogMount,
}

export const restartAgentRuntimeBridgeAction: ActionConfig<typeof ActionContextTypes.GLOBAL> = {
  id: 'restart_agent_runtime_bridge',
  description: 'Restart agent runtime bridge',
  context: ActionContextTypes.GLOBAL,
  handler: () => {
    window.dispatchEvent(new CustomEvent(agentRuntimeBridgeRestartEvent))
  },
}

export const manageAgentTokensAction: ActionConfig<typeof ActionContextTypes.GLOBAL> = {
  id: 'manage_agent_tokens',
  description: 'Manage agent runtime tokens',
  context: ActionContextTypes.GLOBAL,
  handler: () => {
    window.dispatchEvent(new CustomEvent(openAgentTokensDialogEvent))
  },
}

export const agentRuntimePlugin: AppExtension = withSystemExtensionMetadata({
  name: 'Agent runtime',
  description: 'Bridge that lets external agents drive the app through a typed command protocol (also exposes per-token management UI).',
}, [
  appEffectsFacet.of(agentRuntimeBridgeEffect, {source: 'agent-runtime'}),
  appMountsFacet.of(agentRuntimeTokensDialogMount, {source: 'agent-runtime'}),
  actionsFacet.of(restartAgentRuntimeBridgeAction, {source: 'agent-runtime'}),
  actionsFacet.of(manageAgentTokensAction, {source: 'agent-runtime'}),
])
