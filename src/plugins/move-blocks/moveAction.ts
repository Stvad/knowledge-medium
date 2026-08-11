/**
 * "Move block(s) to…" action — opens the move-destination picker over
 * the focused block (NORMAL_MODE) or the current multi-selection
 * (MULTI_SELECT_MODE), then runs `moveBlocksTo` once the user picks a
 * destination. Paired via `defineBlocksAction` so the dialog opens
 * exactly once regardless of how many blocks are being moved.
 *
 * Palette-reachable only — no default keybinding.
 */
import { FolderInput } from 'lucide-react'
import type { Block } from '@/data/block'
import { defineBlocksAction } from '@/shortcuts/utils.js'
import { showError, showSuccess } from '@/utils/toast.js'
import { openDialog } from '@/utils/dialogs.js'
import { MoveDestinationPicker } from './MoveDestinationPicker.tsx'
import { moveBlocksTo } from './moveBlocks.ts'

export const MOVE_BLOCKS_ACTION_ID = 'move-blocks.move-to'

/** Pick a destination (one dialog per invocation) and move every block
 *  in `blocks` there. Used by both context variants — the picker opens
 *  exactly once regardless of how many blocks are being moved. */
const runMoveFlow = async (blocks: readonly Block[]): Promise<void> => {
  if (blocks.length === 0) return
  const repo = blocks[0].repo
  const firstData = blocks[0].peek() ?? await blocks[0].load()
  if (!firstData) return

  const blockIds = blocks.map(block => block.id)
  const choice = await openDialog(MoveDestinationPicker, {
    blockIds,
    workspaceId: firstData.workspaceId,
  })
  if (!choice) return

  try {
    const result = await moveBlocksTo(repo, blockIds, choice.destinationId)
    if (result.moved > 0) {
      showSuccess(`Moved ${result.moved} block${result.moved === 1 ? '' : 's'}`)
    } else {
      showError('No blocks were moved')
    }
  } catch (error) {
    showError(
      error instanceof Error ? error.message : 'Failed to move blocks',
    )
  }
}

const pair = defineBlocksAction({
  id: MOVE_BLOCKS_ACTION_ID,
  icon: FolderInput,
  blockDescription: 'Move block to…',
  blocksDescription: 'Move selected blocks to…',
  flow: runMoveFlow,
})

export const moveBlockAction = pair.block
export const moveBlocksAction = pair.blocks
export const MULTI_SELECT_MOVE_BLOCKS_ACTION_ID = pair.blocks.id
