/**
 * "Move to…" on the bullet's right-click menu — the dependable entry
 * point for the move command.
 *
 * The palette alone isn't enough: opening it with the global ⌘K leaves
 * NORMAL_MODE inactive (only `commandPaletteForBlockAction` focuses the
 * block first), so block-context commands don't list there. The context
 * menu is anchored on the block itself, so it always has one.
 */
import { FolderInput } from 'lucide-react'
import type {
  BlockContextMenuItem,
  BlockContextMenuItemsContribution,
} from '@/extensions/blockInteraction.js'
import { runMoveFlow } from './moveAction.ts'

export const MOVE_BLOCKS_CONTEXT_MENU_ITEM_ID = 'move-blocks.move-to'

export const moveBlocksContextMenuItem: BlockContextMenuItemsContribution =
  ({block, uiStateBlock}): BlockContextMenuItem => ({
    id: MOVE_BLOCKS_CONTEXT_MENU_ITEM_ID,
    label: 'Move to…',
    icon: FolderInput,
    // Acts on the block whose bullet was right-clicked, NOT on any
    // multi-selection: the menu is anchored to one bullet, so honouring
    // a selection the user may not even remember making would move more
    // than they pointed at. Multi-block moves go through the
    // multi-select action instead.
    //
    // `uiStateBlock` is still passed so the flow can take this block out
    // of the selection if it happened to be in one — otherwise a
    // right-click move on a selected bullet leaves a relocated id in a
    // selection that later shortcuts still act on.
    onSelect: () => { void runMoveFlow([block], {uiStateBlock}) },
  })
