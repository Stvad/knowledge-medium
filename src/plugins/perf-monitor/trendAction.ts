/**
 * `view_perf_trend` — opens the trend view. Reachable from the command palette
 * and from the status dropdown's generic action button, which the diagnostics
 * snapshot routes here via `actionId`.
 */
import { TrendingUp } from 'lucide-react'
import { actionsFacet } from '@/extensions/core.js'
import {
  ActionContextTypes,
  type ActionConfig,
  type BaseShortcutDependencies,
} from '@/shortcuts/types.js'
import { isDialogOpenForWorkspace, openDialog } from '@/utils/dialogs.js'
import { VIEW_PERF_TREND_ACTION_ID } from './store.js'
import { PerfTrendDialog } from './PerfTrendDialog.tsx'

export const viewPerfTrendAction: ActionConfig<typeof ActionContextTypes.GLOBAL> = {
  id: VIEW_PERF_TREND_ACTION_ID,
  description: 'View performance trend',
  context: ActionContextTypes.GLOBAL,
  icon: TrendingUp,
  handler: ({ uiStateBlock }: BaseShortcutDependencies) => {
    const workspaceId = uiStateBlock.repo.activeWorkspaceId
    if (isDialogOpenForWorkspace(PerfTrendDialog, workspaceId)) return
    void openDialog(PerfTrendDialog, { workspaceId: workspaceId ?? undefined })
  },
}

export const viewPerfTrendActionContribution = actionsFacet.of(viewPerfTrendAction, {
  source: 'perf-monitor',
})
