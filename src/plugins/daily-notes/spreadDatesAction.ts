import { Shuffle } from 'lucide-react'
import {
  ActionContextTypes,
  type ActionConfig,
  type MultiSelectModeDependencies,
} from '@/shortcuts/types.ts'
import { showError, showSuccess } from '@/utils/toast.ts'
import { openDialog } from '@/utils/dialogs.ts'
import type { GroupedBacklinksGroupHeaderAction } from '@/plugins/grouped-backlinks/facet.ts'
import { hasAnyBlockDateAdapter } from './blockDateAdapter.ts'
import { SpreadDatesDialog } from './SpreadDatesDialog.tsx'
import { spreadBlockDates } from './spreadBlockDates.ts'

export const SPREAD_BLOCK_DATES_ACTION_ID = 'block.date.spread'

/** Randomly spread the dates of every block in `selectedBlocks`
 *  across the next N days. Per-block dispatch is delegated to
 *  `blockDateAdapterFacet` — SRS cards reschedule their next-review
 *  date, blocks with an inline `[[YYYY-MM-DD]]` reference rewrite
 *  the wikilink, and any future adapter joins automatically.
 *
 *  Gated on at least one selected block having a registered adapter
 *  (via runtime lookup), so the surface hides on groups with no
 *  date-bearing blocks. */
export const spreadBlockDatesAction: ActionConfig<
  typeof ActionContextTypes.MULTI_SELECT_MODE
> = {
  id: SPREAD_BLOCK_DATES_ACTION_ID,
  description: 'Spread dates across upcoming days',
  context: ActionContextTypes.MULTI_SELECT_MODE,
  icon: Shuffle,
  canRun: ({selectedBlocks}: MultiSelectModeDependencies) => {
    if (selectedBlocks.length === 0) return false
    // The runtime is shared across blocks; pull it off the first one
    // rather than threading it through deps. Returns null before the
    // runtime has been installed (test setups that skip the setup),
    // in which case we fall back to "permissive" so canRun doesn't
    // hide the surface unconditionally.
    const runtime = selectedBlocks[0].repo.facetRuntime
    if (!runtime) return true
    return selectedBlocks.some(block => hasAnyBlockDateAdapter(runtime, block))
  },
  handler: async ({selectedBlocks}: MultiSelectModeDependencies) => {
    if (selectedBlocks.length === 0) return
    const runtime = selectedBlocks[0].repo.facetRuntime
    if (!runtime) {
      showError('Spread requires the app runtime to be ready')
      return
    }
    const choice = await openDialog(SpreadDatesDialog)
    if (!choice) return
    try {
      const result = await spreadBlockDates(runtime, selectedBlocks, {
        days: choice.days,
      })
      if (result.updated > 0) {
        showSuccess(
          `Spread ${result.updated} date${result.updated === 1 ? '' : 's'}`,
        )
      } else if (result.eligible === 0) {
        showError('No blocks with a date adapter were selected')
      } else {
        showError('No dates were updated')
      }
    } catch (error) {
      showError(
        error instanceof Error ? error.message : 'Failed to spread dates',
      )
    }
  },
}

export const spreadBlockDatesGroupHeaderEntry: GroupedBacklinksGroupHeaderAction = {
  actionId: SPREAD_BLOCK_DATES_ACTION_ID,
}
