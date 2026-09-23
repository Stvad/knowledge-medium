import { RefreshCw } from 'lucide-react'
import { actionsFacet } from '@/extensions/core.js'
import {
  ActionContextTypes,
  type ActionConfig,
  type BaseShortcutDependencies,
} from '@/shortcuts/types.js'
import { rematerializeWorkspaceWithFeedback } from '@/utils/workspaceRecovery.js'
import { showInfo } from '@/utils/toast.js'

export const REMATERIALIZE_WORKSPACE_ACTION_ID = 'system_status.rematerialize_workspace'

export const rematerializeWorkspaceAction: ActionConfig<typeof ActionContextTypes.GLOBAL> = {
  id: REMATERIALIZE_WORKSPACE_ACTION_ID,
  description: 'Repair downloaded workspace data',
  context: ActionContextTypes.GLOBAL,
  icon: RefreshCw,
  handler: async ({uiStateBlock}: BaseShortcutDependencies) => {
    const {repo} = uiStateBlock
    // Pin the workspace at invocation. The helper reports against this id even
    // if the user switches workspaces while the drain is running.
    const workspaceId = repo.activeWorkspaceId
    if (!workspaceId) {
      showInfo('Local workspace recovery: no active workspace.')
      return
    }
    await rematerializeWorkspaceWithFeedback(repo, workspaceId)
  },
}

export const rematerializeWorkspaceActionContribution = actionsFacet.of(
  rematerializeWorkspaceAction,
  {source: 'system-status'},
)
