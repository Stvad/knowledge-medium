import { Shuffle } from 'lucide-react'
import {
  ActionContextTypes,
  type ActionConfig,
  type MultiSelectModeDependencies,
} from '@/shortcuts/types.ts'
import { showError, showSuccess } from '@/utils/toast.ts'
import { openDialog } from '@/utils/dialogs.ts'
import type { GroupedBacklinksGroupHeaderAction } from '@/plugins/grouped-backlinks/facet.ts'
import { spreadSrsReviewDates } from './spreadReviews.ts'
import { srsBlockDateAdapter } from './srsBlockDateAdapter.ts'
import { SpreadDaysDialog } from './SpreadDaysDialog.tsx'

export const SRS_SPREAD_REVIEWS_ACTION_ID = 'srs.spread.reviews'

/** Spread the next-review date of every eligible SRS card in
 *  `selectedBlocks` randomly across the next N days. The handler
 *  opens a small dialog to ask for N — same prompt the old
 *  grouped-backlinks header button surfaced, now reachable through
 *  every MULTI_SELECT_MODE surface (command palette, real
 *  multi-select, group header). */
export const srsSpreadReviewsAction: ActionConfig<
  typeof ActionContextTypes.MULTI_SELECT_MODE
> = {
  id: SRS_SPREAD_REVIEWS_ACTION_ID,
  description: 'SRS: Spread reviews across upcoming days',
  context: ActionContextTypes.MULTI_SELECT_MODE,
  icon: Shuffle,
  canRun: ({selectedBlocks}: MultiSelectModeDependencies) =>
    selectedBlocks.some(block => srsBlockDateAdapter.canHandle(block)),
  handler: async ({selectedBlocks}: MultiSelectModeDependencies) => {
    const choice = await openDialog(SpreadDaysDialog)
    if (!choice) return
    try {
      const result = await spreadSrsReviewDates(selectedBlocks, {
        days: choice.days,
      })
      if (result.updated > 0) {
        showSuccess(
          `Spread ${result.updated} SRS review${result.updated === 1 ? '' : 's'}`,
        )
      } else {
        showError('No SRS reviews were updated')
      }
    } catch (error) {
      showError(
        error instanceof Error ? error.message : 'Failed to spread SRS reviews',
      )
    }
  },
}

export const srsSpreadReviewsGroupHeaderEntry: GroupedBacklinksGroupHeaderAction = {
  actionId: SRS_SPREAD_REVIEWS_ACTION_ID,
}
