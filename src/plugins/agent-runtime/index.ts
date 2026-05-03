import { appEffectsFacet, type AppEffect } from '@/extensions/core.ts'
import type { AppExtension } from '@/extensions/facet.ts'
import { startAgentRuntimeBridge } from './bridge.ts'

export { AgentTokensDialogMount, openAgentTokensDialogEvent } from './AgentTokensDialog.tsx'
export { agentRuntimeBridgeRestartEvent } from './bridge.ts'

export const agentRuntimeBridgeEffect: AppEffect = {
  id: 'agent-runtime.bridge',
  start: startAgentRuntimeBridge,
}

export const agentRuntimePlugin: AppExtension = [
  appEffectsFacet.of(agentRuntimeBridgeEffect, {source: 'agent-runtime'}),
]
