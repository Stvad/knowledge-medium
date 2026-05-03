import {
  appEffectsFacet,
  appMountsFacet,
  type AppEffect,
  type AppMountContribution,
} from '@/extensions/core.ts'
import type { AppExtension } from '@/extensions/facet.ts'
import { AgentTokensDialogMount } from './AgentTokensDialog.tsx'
import { startAgentRuntimeBridge } from './bridge.ts'

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

export const agentRuntimePlugin: AppExtension = [
  appEffectsFacet.of(agentRuntimeBridgeEffect, {source: 'agent-runtime'}),
  appMountsFacet.of(agentRuntimeTokensDialogMount, {source: 'agent-runtime'}),
]
