/**
 * Extends the daily-notes "Reschedule" action so it stays visible on
 * SRS blocks that don't have an inline date reference (where the base
 * `canRun` would say "nope, no shiftable date here"). The handler is
 * shared — it only opens the picker, and the picker resolves the right
 * adapter at commit time via `blockDateAdapterFacet`.
 */
import {
  RESCHEDULE_BLOCK_DATE_ACTION_ID,
} from '@/plugins/daily-notes/rescheduleAction.ts'
import type {
  ActionConfig,
  ActionDecorator,
  BlockShortcutDependencies,
} from '@/shortcuts/types.ts'
import { srsBlockDateAdapter } from './srsBlockDateAdapter.ts'

export const srsRescheduleDecorator: ActionDecorator = {
  actionId: RESCHEDULE_BLOCK_DATE_ACTION_ID,
  decorate: (action: ActionConfig): ActionConfig => ({
    ...action,
    canRun: (deps) => {
      const block = (deps as BlockShortcutDependencies).block
      if (block && srsBlockDateAdapter.canHandle(block)) return true
      return action.canRun?.(deps as never) ?? true
    },
  }),
}
