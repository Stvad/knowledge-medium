/**
 * What touch does to the block selection. Both are ordinary `block-pointer`
 * actions dispatched with the touched block's deps; the selection they edit
 * is the same one Shift/Cmd-click and Shift+Arrow build, so multi-select mode
 * and its actions are unchanged.
 */
import { toggleBlockInSelection } from '@/extensions/blockSelectionAction.js'
import { topLevelBlockIdProp } from '@/data/properties.js'
import { getSelectionStateSnapshot, hasBlockSelection } from '@/data/stateBlocks.js'
import { ActionContextTypes, type ActionConfig, type BlockPointerDependencies } from '@/shortcuts/types.js'
import { isPointerCoarse } from '@/utils/viewport.js'
import { BLOCK_HOLD_GESTURE } from './holdRecognizer.ts'

/** The panel's own root (its page title or zoom root) is never selected, as
 *  Shift+Arrow refuses it too: selecting it would replace every selected
 *  descendant, and the structural actions mean nothing on a view's root. */
const isPanelRoot = ({block, uiStateBlock}: BlockPointerDependencies): boolean =>
  block.id === uiStateBlock.peekProperty(topLevelBlockIdProp)

/** Hold a block to select it, which starts multi-select mode when nothing
 *  was selected. A hold on a block already in the selection, or on the
 *  panel's root, changes nothing but is still handled, so its release
 *  doesn't open the block. */
export const selectHeldBlockAction: ActionConfig<typeof ActionContextTypes.BLOCK_POINTER> = {
  id: 'touch-selection.select-held-block',
  description: 'Select the held block',
  context: ActionContextTypes.BLOCK_POINTER,
  gestureBinding: {gesture: BLOCK_HOLD_GESTURE},
  handler: async deps => {
    if (isPanelRoot(deps)) return
    if (getSelectionStateSnapshot(deps.uiStateBlock).selectedBlockIds.includes(deps.block.id)) return
    await toggleBlockInSelection(deps)
  },
}

/** While blocks are selected on a touch device, a tap on a block adds it to
 *  the selection or takes it out; taking out the last one ends the mode. The
 *  plain click binding catches what the content tap doesn't: a press longer
 *  than a tap but shorter than a hold, and a tap on the row beside the text,
 *  each of which iOS turns into a click that would otherwise edit the block
 *  and drop the selection. A tap on the panel's root is handled and changes
 *  nothing. With nothing selected it declines, and the tap edits as usual. */
export const toggleTappedBlockAction: ActionConfig<typeof ActionContextTypes.BLOCK_POINTER> = {
  id: 'touch-selection.toggle-tapped-block',
  description: 'Add the tapped block to the selection, or remove it',
  context: ActionContextTypes.BLOCK_POINTER,
  pointerBinding: [
    {kind: 'touch', phase: 'tap'},
    {kind: 'mouse', mods: [], phase: 'click'},
  ],
  canDispatch: ({uiStateBlock}) => hasBlockSelection(uiStateBlock) && isPointerCoarse(),
  handler: async deps => {
    if (isPanelRoot(deps)) return
    await toggleBlockInSelection(deps)
  },
}
