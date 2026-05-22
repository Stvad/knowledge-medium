/**
 * "Reschedule" quick-action — opens the calendar+strip sheet over the
 * swiped block. The base action's `canRun` gates on the regular
 * date-reference adapter; the SRS plugin contributes a decorator that
 * extends the gate to SRS blocks. The picker itself looks up the right
 * adapter via `blockDateAdapterFacet` at commit time, so the handler
 * doesn't need to know which kind of block it's acting on.
 */
import { CalendarRange } from 'lucide-react'
import {
  ActionConfig,
  ActionContextTypes,
  type BlockShortcutDependencies,
} from '@/shortcuts/types.ts'
import type { QuickActionItem } from '@/plugins/swipe-quick-actions/actions.ts'
import { referenceDateAdapter } from './referenceDateAdapter.ts'
import { openReschedulePicker } from './rescheduleEvents.ts'

export const RESCHEDULE_BLOCK_DATE_ACTION_ID = 'block.date.reschedule'

export const rescheduleBlockDateAction: ActionConfig<typeof ActionContextTypes.NORMAL_MODE> = {
  id: RESCHEDULE_BLOCK_DATE_ACTION_ID,
  description: 'Reschedule block date',
  context: ActionContextTypes.NORMAL_MODE,
  icon: CalendarRange,
  canRun: ({block}) => referenceDateAdapter.canHandle(block),
  handler: async ({block}: BlockShortcutDependencies) => {
    const data = block.peek() ?? await block.load()
    if (!data) return
    openReschedulePicker({
      blockId: block.id,
      workspaceId: data.workspaceId,
    })
  },
}

export const rescheduleQuickActionItem: QuickActionItem = {
  actionId: RESCHEDULE_BLOCK_DATE_ACTION_ID,
  label: 'Reschedule',
}
