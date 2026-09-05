import type { Repo } from '@/data/repo'
import type { AppExtension } from '@/facets/facet.js'
import { systemToggle } from '@/facets/togglable.js'
import { actionsFacet } from '@/extensions/core.js'
import { blockContentDecoratorsFacet } from '@/extensions/blockInteraction.js'
import { agentStatusChipContribution } from './AgentStatusChip.tsx'
import { askAgentActions } from './askAgent.ts'
import { cancelAgentActions } from './cancelAgent.ts'
import { retryAgentActions } from './retryAgent.ts'
import { copyAgentResumeCommandActions } from './resumeCommand.ts'

const SOURCE = 'agent-dispatch-companion'

/** UI companion for the agent-dispatch daemon (packages/agent-dispatch):
 *  surfaces the `agent:*` task lifecycle the daemon writes into the
 *  graph (status chips) and offers the explicit Ask Agent / Retry / Stop
 *  triggers. The chips are pure readers — they work on every device,
 *  daemon or not; the action degrades to a plain [[claude]] mention when
 *  no daemon is listening. */
export const agentDispatchCompanionPlugin = ({repo}: {repo: Repo}): AppExtension => systemToggle({
  id: 'system:agent-dispatch-companion',
  name: 'Agent dispatch companion',
  description:
    'Status chips + Ask Agent / Retry actions for blocks the agent-dispatch daemon processes.',
}).of([
  blockContentDecoratorsFacet.of(agentStatusChipContribution, { source: SOURCE }),
  ...askAgentActions.map(action => actionsFacet.of(action, { source: SOURCE })),
  ...cancelAgentActions.map(action => actionsFacet.of(action, { source: SOURCE })),
  ...retryAgentActions({repo}).map(action => actionsFacet.of(action, { source: SOURCE })),
  ...copyAgentResumeCommandActions.map(action => actionsFacet.of(action, { source: SOURCE })),
])
