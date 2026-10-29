import { MULTI_SELECT_MOVE_BLOCKS_ACTION_ID } from '@/plugins/move-blocks'
import { multiSelectActionId } from '@/shortcuts/utils.js'
import { ActionContextTypes } from '@/shortcuts/types.js'
import type { TouchSelectionToolbarItem } from './facet.ts'

/** The selection toolbar's buttons, by precedence (ascending = leftmost):
 *  the multi-select mode's own structural moves, the Move-to picker, undo,
 *  and the button that ends the selection, pinned last. */
export const defaultToolbarItems: readonly {
  precedence: number
  item: TouchSelectionToolbarItem
}[] = [
  {precedence: 10, item: {id: 'outdent', actionId: multiSelectActionId('outdent_block')}},
  {precedence: 20, item: {id: 'indent', actionId: multiSelectActionId('indent_block')}},
  {precedence: 30, item: {id: 'move-up', actionId: multiSelectActionId('move_block_up')}},
  {precedence: 40, item: {id: 'move-down', actionId: multiSelectActionId('move_block_down')}},
  {precedence: 50, item: {id: 'move-to', actionId: MULTI_SELECT_MOVE_BLOCKS_ACTION_ID}},
  {precedence: 90, item: {id: 'undo', actionId: 'undo', context: ActionContextTypes.GLOBAL}},
  {precedence: 1000, item: {id: 'done', actionId: 'clear_selection'}},
]
