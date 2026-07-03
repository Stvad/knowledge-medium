import type { AppExtension } from '@/facets/facet.js'
import { systemToggle } from '@/facets/togglable.js'
import { blockContentDecoratorsFacet } from '@/extensions/blockInteraction.js'
import { claudeStatusChipContribution } from './ClaudeStatusChip.tsx'

const SOURCE = 'claude-tasks-companion'

/** UI companion for the claude-tasks daemon (packages/claude-tasks):
 *  surfaces the `claude:*` task lifecycle the daemon writes into the
 *  graph. Pure reader — works on every device, daemon or not. */
export const claudeTasksCompanionPlugin: AppExtension = systemToggle({
  id: 'system:claude-tasks-companion',
  name: 'Claude tasks companion',
  description:
    'Status chips for Claude task blocks: shows working/replied/failed on blocks the claude-tasks daemon processes.',
}).of([
  blockContentDecoratorsFacet.of(claudeStatusChipContribution, { source: SOURCE }),
])
