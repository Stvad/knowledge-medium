import type { AppExtension } from '@/facets/facet.js'
import { systemToggle } from '@/facets/togglable.js'
import { actionsFacet } from '@/extensions/core.js'
import { blockContentDecoratorsFacet } from '@/extensions/blockInteraction.js'
import { agentStatusChipContribution } from './AgentStatusChip.tsx'
import { askAgentActions } from './askAgent.ts'
import { cancelAgentActions } from './cancelAgent.ts'

const SOURCE = 'agent-dispatch-companion'

/** UI companion for the agent-dispatch daemon (packages/agent-dispatch):
 *  surfaces the `agent:*` task lifecycle the daemon writes into the
 *  graph (status chips) and offers the explicit Ask Agent trigger.
 *  The chips are pure readers — they work on every device, daemon or
 *  not; the action degrades to a plain [[claude]] mention when no
 *  daemon is listening. */
export const agentDispatchCompanionPlugin: AppExtension = systemToggle({
  id: 'system:agent-dispatch-companion',
  name: 'Agent dispatch companion',
  description:
    'Status chips + Ask Agent action for blocks the agent-dispatch daemon processes.',
}).of([
  blockContentDecoratorsFacet.of(agentStatusChipContribution, { source: SOURCE }),
  ...askAgentActions.map(action => actionsFacet.of(action, { source: SOURCE })),
  ...cancelAgentActions.map(action => actionsFacet.of(action, { source: SOURCE })),
])
