import { Shuffle } from 'lucide-react'
import type { Block } from '@/data/block'
import type { FacetRuntime } from '@/extensions/facet.ts'
import { defineBlocksAction } from '@/shortcuts/utils.ts'
import { showError, showSuccess } from '@/utils/toast.ts'
import { openDialog } from '@/utils/dialogs.ts'
import type { GroupedBacklinksGroupHeaderAction } from '@/plugins/grouped-backlinks/facet.ts'
import { hasAnyBlockDateAdapter } from './blockDateAdapter.ts'
import { SpreadDatesDialog } from './SpreadDatesDialog.tsx'
import { spreadBlockDates } from './spreadBlockDates.ts'

export const SPREAD_BLOCK_DATES_ACTION_ID = 'block.date.spread'

/** Prompt for the day window once, then dispatch `spreadBlockDates`
 *  over the supplied blocks. The runtime carries the registered
 *  `blockDateAdapterFacet` so adapter dispatch stays uniform across
 *  the NORMAL_MODE and MULTI_SELECT_MODE entry points. */
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

const pair = defineBlocksAction({
  id: SPREAD_BLOCK_DATES_ACTION_ID,
  icon: Shuffle,
  blockDescription: 'Spread block date across upcoming days',
  blocksDescription: 'Spread dates across upcoming days',
  appliesTo: (block: Block) => {
    // canRun runs sync during render; fall back to "permissive"
    // when the runtime isn't installed yet (test setups) so the
    // surface doesn't disappear unconditionally.
    const runtime = block.repo.facetRuntime
    if (!runtime) return true
    return hasAnyBlockDateAdapter(runtime, block)
  },
  flow: (blocks: readonly Block[]) =>
    runSpreadFlow(blocks, blocks[0]?.repo.facetRuntime ?? null),
})

export const spreadBlockDateAction = pair.block
export const spreadBlockDatesAction = pair.blocks
export const SPREAD_BLOCK_DATES_BLOCKS_ACTION_ID = pair.blocks.id

export const spreadBlockDatesGroupHeaderEntry: GroupedBacklinksGroupHeaderAction = {
  actionId: pair.blocks.id,
}
