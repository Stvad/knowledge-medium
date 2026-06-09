import { focusBlock, selectionStateProp } from '@/data/properties.js'
import { getSelectionStateSnapshot } from '@/data/stateBlocks.js'
import { ActionContextTypes, type ActionConfig } from '@/shortcuts/types.js'
import { extendSelection, validateSelectionHierarchy } from '@/utils/selection.js'

export const EXTEND_BLOCK_SELECTION_ACTION_ID = 'extend_block_selection'
export const TOGGLE_BLOCK_SELECTION_ACTION_ID = 'toggle_block_selection'

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

/**
 * Ctrl/Cmd-click block selection: toggle the clicked block in or out of the
 * selection set (with hierarchy validation), then focus it. The pointer
 * counterpart of the structural ctrl/meta branch that used to live in
 * `handleBlockSelectionClick`.
 *
 * Two bindings because modifier matching is exact-set: `$mod` (Cmd on macOS,
 * Ctrl elsewhere) AND literal `Control` (so Ctrl-click toggles on macOS too,
 * matching the prior `ctrlKey || metaKey` behaviour). Lives in `block-pointer`
 * like the extend action; the context's `pointerTargetFilter` keeps it off
 * interactive descendants.
 *
 * Behaviour note: exact-set matching means a COMBINED-modifier click
 * (ctrl/cmd+shift, ctrl+alt, …) matches neither toggle, extend, nor edit, so it
 * falls through to native — a deliberate change from the old precedence chain
 * (`if (ctrl||meta) toggle; else if (shift) extend`), where ctrl/meta + any
 * other modifier still toggled. That combined-modifier toggling was incidental,
 * not designed; if a real additive-range gesture is wanted later, bind it
 * explicitly (e.g. `['$mod','Shift']`) rather than reviving the precedence.
 */
export const toggleBlockSelectionAction: ActionConfig<typeof ActionContextTypes.BLOCK_POINTER> = {
  id: TOGGLE_BLOCK_SELECTION_ACTION_ID,
  description: 'Toggle the clicked block in the selection',
  context: ActionContextTypes.BLOCK_POINTER,
  pointerBinding: [
    {kind: 'mouse', mods: ['$mod'], phase: 'click'},
    {kind: 'mouse', mods: ['Control'], phase: 'click'},
  ],
  handler: async ({block, uiStateBlock, renderScopeId}) => {
    const repo = uiStateBlock.repo
    const selectionState = getSelectionStateSnapshot(uiStateBlock)
    const isSelected = selectionState.selectedBlockIds.includes(block.id)
    const newSelectedIds = isSelected
      ? selectionState.selectedBlockIds.filter(id => id !== block.id)
      : [...selectionState.selectedBlockIds, block.id]

    const validatedIds = await validateSelectionHierarchy(newSelectedIds, repo)

    void uiStateBlock.set(selectionStateProp, {
      selectedBlockIds: validatedIds,
      anchorBlockId: validatedIds.length > 0
        ? (selectionState.anchorBlockId || block.id)
        : null,
    })

    void focusBlock(uiStateBlock, block.id, renderScopeId ? {renderScopeId} : undefined)
  },
}
