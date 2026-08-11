/**
 * "Move block(s) to…" action — opens the move-destination picker over
 * the focused block (NORMAL_MODE) or the current multi-selection
 * (MULTI_SELECT_MODE), then runs `moveBlocksTo` once the user picks a
 * destination. Paired via `defineBlocksAction` so the dialog opens
 * exactly once regardless of how many blocks are being moved.
 *
 * No default keybinding. The bullet's "Move to…" context-menu entry
 * (`contextMenuItem.ts`) is the dependable single-block entry point;
 * the palette only lists these when a block context is actually active.
 */
import { FolderInput } from 'lucide-react'
import type { Block } from '@/data/block'
import { defineBlocksAction, type BlocksActionContext } from '@/shortcuts/utils.js'
import { showError, showSuccess } from '@/utils/toast.js'
import { getSelectionStateSnapshot } from '@/data/stateBlocks.js'
import { selectionStateProp } from '@/data/properties.js'
import { openDialog } from '@/utils/dialogs.js'
import { MoveDestinationPicker } from './MoveDestinationPicker.tsx'
import { moveBlocksTo, PartialMoveError } from './moveBlocks.ts'

export const MOVE_BLOCKS_ACTION_ID = 'move-blocks.move-to'

/**
 * Take the just-moved ids out of the ui-state selection.
 *
 * The selection is ui-state, and `PanelMultiSelectActionContext`
 * activates multi-select from a non-empty `selectedBlockIds` ALONE — it
 * never checks those blocks are still in the panel. Leave a relocated id
 * in there and the pane shows nothing (or only the un-moved remainder)
 * highlighted while `Delete` and the other multi-select shortcuts still
 * act on the block at its new home.
 *
 * Subtracting ids — rather than clearing outright when the dispatch came
 * from multi-select — is what makes the two entry points behave the
 * same. A multi-select move takes out every selected id and so empties
 * the selection anyway, while a context-menu move on one bullet that
 * happens to sit inside a live selection removes just that one and
 * leaves the rest intact. A selection with nothing moved in it is
 * untouched, which is the behaviour a normal-mode move on an unrelated
 * block needs.
 *
 * No ancestor/descendant subtlety to handle: `validateSelectionHierarchy`
 * guarantees a stored selection never holds both a block and its own
 * descendant, so a moved id can't leave a selected descendant behind.
 */
const dropMovedFromSelection = async (
  uiStateBlock: Block,
  movedIds: readonly string[],
): Promise<void> => {
  const current = getSelectionStateSnapshot(uiStateBlock)
  if (!current.selectedBlockIds.length) return

  const moved = new Set(movedIds)
  const remaining = current.selectedBlockIds.filter(id => !moved.has(id))
  if (remaining.length === current.selectedBlockIds.length) return

  await uiStateBlock.set(selectionStateProp, {
    selectedBlockIds: remaining,
    // The anchor is only meaningful while it's still selected; a moved
    // anchor would keep range-extension anchored to an off-surface row.
    anchorBlockId:
      current.anchorBlockId && remaining.includes(current.anchorBlockId)
        ? current.anchorBlockId
        : remaining[0] ?? null,
  })
}

/** Pick a destination (one dialog per invocation) and move every block
 *  in `blocks` there. Used by both context variants — the picker opens
 *  exactly once regardless of how many blocks are being moved.
 *
 *  Exported because the bullet context-menu entry needs the same flow:
 *  the global ⌘K palette does NOT surface NORMAL_MODE actions (it opens
 *  without the block-focus step `commandPaletteForBlockAction` does, so
 *  the block context isn't active and only Global commands list), which
 *  leaves the context menu as the dependable entry point. */
export const runMoveFlow = async (
  blocks: readonly Block[],
  context?: BlocksActionContext,
): Promise<void> => {
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
    // Picking a destination block means "put them inside it", i.e. at
    // the end of its children — the picker offers no finer placement.
    const result = await moveBlocksTo(repo, blockIds, {
      parentId: choice.destinationId,
      position: { kind: 'last' },
    })
    if (result.moved > 0) {
      if (context) await dropMovedFromSelection(context.uiStateBlock, result.movedIds)
      showSuccess(`Moved ${result.moved} block${result.moved === 1 ? '' : 's'}`)
    } else {
      showError('No blocks were moved')
    }
  } catch (error) {
    // A partial failure still relocated its prefix, so those ids need the
    // same selection bookkeeping a success does — otherwise Delete and the
    // other multi-select shortcuts keep reaching them at their new home.
    if (context && error instanceof PartialMoveError) {
      await dropMovedFromSelection(context.uiStateBlock, error.movedIds)
    }
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
