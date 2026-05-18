import { Shuffle } from 'lucide-react'
import type { Block } from '@/data/block'
import type { FacetRuntime } from '@/extensions/facet.ts'
import {
  ActionContextTypes,
  type ActionConfig,
  type BlockShortcutDependencies,
  type MultiSelectModeDependencies,
} from '@/shortcuts/types.ts'
import { showError, showSuccess } from '@/utils/toast.ts'
import { openDialog } from '@/utils/dialogs.ts'
import type { GroupedBacklinksGroupHeaderAction } from '@/plugins/grouped-backlinks/facet.ts'
import { hasAnyBlockDateAdapter } from './blockDateAdapter.ts'
import { SpreadDatesDialog } from './SpreadDatesDialog.tsx'
import { spreadBlockDates } from './spreadBlockDates.ts'

export const SPREAD_BLOCK_DATES_ACTION_ID = 'block.date.spread'

/** Shared flow: prompt for the day window once, then dispatch
 *  `spreadBlockDates` over the supplied blocks. The runtime carries
 *  the registered `blockDateAdapterFacet` so adapter dispatch stays
 *  uniform across the NORMAL_MODE (single block) and
 *  MULTI_SELECT_MODE (selection) entry points. */
const runSpreadFlow = async (
  blocks: readonly Block[],
  runtime: FacetRuntime | null,
): Promise<void> => {
  if (blocks.length === 0) return
  if (!runtime) {
    showError('Spread requires the app runtime to be ready')
    return
  }
  const choice = await openDialog(SpreadDatesDialog)
  if (!choice) return
  try {
    const result = await spreadBlockDates(runtime, blocks, {days: choice.days})
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
}

/** NORMAL_MODE entry point — spread the focused block's date.
 *  Equivalent to "randomize my date within the next N days" for any
 *  block whose date is reachable through the adapter facet. */
export const spreadBlockDateAction: ActionConfig<
  typeof ActionContextTypes.NORMAL_MODE
> = {
  id: SPREAD_BLOCK_DATES_ACTION_ID,
  description: 'Spread block date across upcoming days',
  context: ActionContextTypes.NORMAL_MODE,
  icon: Shuffle,
  canRun: ({block}: BlockShortcutDependencies) => {
    const runtime = block.repo.facetRuntime
    if (!runtime) return true
    return hasAnyBlockDateAdapter(runtime, block)
  },
  handler: ({block}: BlockShortcutDependencies) =>
    runSpreadFlow([block], block.repo.facetRuntime),
}

/** MULTI_SELECT_MODE entry point — spread every block in
 *  `selectedBlocks`. Per-block dispatch is delegated to
 *  `blockDateAdapterFacet`, so SRS cards reschedule their
 *  next-review date and blocks with an inline `[[YYYY-MM-DD]]`
 *  reference rewrite the wikilink in a single invocation.
 *
 *  Gated on at least one selected block having a registered adapter
 *  so the surface hides on groups with no date-bearing blocks. */
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
  handler: ({selectedBlocks}: MultiSelectModeDependencies) =>
    runSpreadFlow(selectedBlocks, selectedBlocks[0]?.repo.facetRuntime ?? null),
}

export const spreadBlockDatesGroupHeaderEntry: GroupedBacklinksGroupHeaderAction = {
  actionId: SPREAD_BLOCK_DATES_ACTION_ID,
}
