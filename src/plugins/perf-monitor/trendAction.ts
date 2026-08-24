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
import { getDialogQueue, openDialog } from '@/utils/dialogs.js'
import { VIEW_PERF_TREND_ACTION_ID } from './store.js'
import { PerfTrendDialog } from './PerfTrendDialog.tsx'

/** True when the trend view is already open for this workspace. The action is
 *  cheap and repeatable (the chip button invites re-clicking), so it must not
 *  stack copies — but a view pinned to a DIFFERENT workspace does not cover
 *  this request, so that one still opens. */
const trendDialogAlreadyShows = (workspaceId: string | null): boolean =>
  getDialogQueue().some(
    (entry) =>
      (entry.Component as unknown) === PerfTrendDialog &&
      (entry.props.workspaceId as string | undefined) === (workspaceId ?? undefined),
  )

export const viewPerfTrendAction: ActionConfig<typeof ActionContextTypes.GLOBAL> = {
  id: VIEW_PERF_TREND_ACTION_ID,
  description: 'View performance trend',
  context: ActionContextTypes.GLOBAL,
  icon: TrendingUp,
  handler: ({ uiStateBlock }: BaseShortcutDependencies) => {
    const workspaceId = uiStateBlock.repo.activeWorkspaceId
    if (trendDialogAlreadyShows(workspaceId)) return
    void openDialog(PerfTrendDialog, { workspaceId: workspaceId ?? undefined })
  },
}

export const viewPerfTrendActionContribution = actionsFacet.of(viewPerfTrendAction, {
  source: 'perf-monitor',
})
