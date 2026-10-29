/**
 * What touch does to the block selection. Both are ordinary `block-pointer`
 * actions dispatched with the touched block's deps; the selection they edit
 * is the same one Shift/Cmd-click and Shift+Arrow build, so multi-select mode
 * and its actions are unchanged.
 */
import { toggleBlockInSelection } from '@/extensions/blockSelectionAction.js'
import { getSelectionStateSnapshot, hasBlockSelection } from '@/data/stateBlocks.js'
import { ActionContextTypes, type ActionConfig } from '@/shortcuts/types.js'
import { BLOCK_HOLD_GESTURE } from './holdRecognizer.ts'

/** Hold a block to select it, which starts multi-select mode when nothing
 *  was selected. A hold on a block already in the selection changes nothing
 *  but is still handled, so its release doesn't open the block. */
export const selectHeldBlockAction: ActionConfig<typeof ActionContextTypes.BLOCK_POINTER> = {
  id: 'touch-selection.select-held-block',
  description: 'Select the held block',
  context: ActionContextTypes.BLOCK_POINTER,
  gestureBinding: {gesture: BLOCK_HOLD_GESTURE},
  handler: async deps => {
    if (getSelectionStateSnapshot(deps.uiStateBlock).selectedBlockIds.includes(deps.block.id)) return
    await toggleBlockInSelection(deps)
  },
}

/** While blocks are selected, a tap on a block's content adds it to the
 *  selection or takes it out; taking out the last one ends the mode. With
 *  nothing selected it declines, and the tap edits the block as usual. */
export const toggleTappedBlockAction: ActionConfig<typeof ActionContextTypes.BLOCK_POINTER> = {
  id: 'touch-selection.toggle-tapped-block',
  description: 'Add the tapped block to the selection, or remove it',
  context: ActionContextTypes.BLOCK_POINTER,
  pointerBinding: {kind: 'touch', phase: 'tap'},
  canDispatch: ({uiStateBlock}) => hasBlockSelection(uiStateBlock),
  handler: deps => toggleBlockInSelection(deps),
}
