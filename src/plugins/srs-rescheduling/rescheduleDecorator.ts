/**
 * Extends the daily-notes "Reschedule" action so it stays visible on
 * SRS blocks that don't have an inline date reference (where the base
 * `isVisible` would say "nope, no shiftable date here"). The handler is
 * shared — it only opens the picker, and the picker resolves the right
 * adapter at commit time via `blockDateAdapterFacet`.
 */
import {
  RESCHEDULE_BLOCK_DATE_ACTION_ID,
} from '@/plugins/daily-notes/rescheduleAction.js'
import type {
  ActionConfig,
  ActionTransform,
  BlockShortcutDependencies,
} from '@/shortcuts/types.js'
import { srsBlockDateAdapter } from './srsBlockDateAdapter.ts'

export const srsRescheduleDecorator: ActionTransform = {
  actionId: RESCHEDULE_BLOCK_DATE_ACTION_ID,
  apply: (action: ActionConfig): ActionConfig => ({
    ...action,
    isVisible: (deps) => {
      const block = (deps as BlockShortcutDependencies).block
      if (block && srsBlockDateAdapter.canHandle(block)) return true
      return action.isVisible?.(deps as never) ?? true
    },
  }),
}
