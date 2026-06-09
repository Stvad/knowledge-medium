import { focusBlock } from '@/data/properties.js'
import { ActionContextTypes, type ActionConfig } from '@/shortcuts/types.js'
import { extendSelection } from '@/utils/selection.js'

export const EXTEND_BLOCK_SELECTION_ACTION_ID = 'extend_block_selection'

/**
 * Shift-click block selection, structural variant: extend the data-tree
 * visible-order range from the current selection anchor to the clicked block,
 * then focus it. The pointer counterpart of the keyboard `extend_selection_*`
 * actions, and the base that spatial navigation decorates (an `ActionTransform`)
 * to range in visible DOM order across backlinks/embeds — declining back to
 * this structural behaviour when no spatial range resolves.
 *
 * Lives in the `block-pointer` context: never keyboard-active, dispatched only
 * via the pointer path with the clicked block's deps supplied. Carries a
 * pointer binding (plain shift-click) and no keyboard `defaultBinding`, so it
 * never appears in keybinding settings or the command palette.
 */
export const extendBlockSelectionAction: ActionConfig<typeof ActionContextTypes.BLOCK_POINTER> = {
  id: EXTEND_BLOCK_SELECTION_ACTION_ID,
  description: 'Extend block selection to the clicked block',
  context: ActionContextTypes.BLOCK_POINTER,
  pointerBinding: {kind: 'mouse', mods: ['Shift'], phase: 'click'},
  handler: async ({block, uiStateBlock, scopeRootId, scopeRootForcesOpen, renderScopeId}) => {
    await extendSelection(
      block.id,
      uiStateBlock,
      uiStateBlock.repo,
      scopeRootId,
      scopeRootForcesOpen ?? true,
    )
    void focusBlock(uiStateBlock, block.id, renderScopeId ? {renderScopeId} : undefined)
  },
}
