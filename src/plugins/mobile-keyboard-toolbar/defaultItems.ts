import { ActionContextTypes } from '@/shortcuts/types.js'
import { EXIT_EDIT_ACTION_ID, type MobileKeyboardToolbarItem } from './facet.ts'
import {
  INSERT_BLOCK_REF_TRIGGER_ACTION_ID,
  INSERT_PAGE_REF_TRIGGER_ACTION_ID,
} from './actions.ts'

/** The toolbar's own buttons — the structural / reference / undo / done set,
 *  paired with their contribution `precedence` (ascending = earlier). Each item
 *  is a reference to an action; the glyph + label come from the action. Other
 *  plugins contribute their buttons to the same facet (attachments' image at
 *  precedence 50, between block-ref and move-up); "Done" is pinned last. */
export const defaultToolbarItems: readonly {
  precedence: number
  item: MobileKeyboardToolbarItem
}[] = [
  {precedence: 10, item: {id: 'outdent', actionId: 'edit.cm.outdent_block'}},
  {precedence: 20, item: {id: 'indent', actionId: 'edit.cm.indent_block'}},
  {precedence: 30, item: {id: 'page-ref', actionId: INSERT_PAGE_REF_TRIGGER_ACTION_ID}},
  {precedence: 40, item: {id: 'block-ref', actionId: INSERT_BLOCK_REF_TRIGGER_ACTION_ID}},
  {precedence: 70, item: {id: 'move-up', actionId: 'move_block_up_cm'}},
  {precedence: 80, item: {id: 'move-down', actionId: 'move_block_down_cm'}},
  // undo/redo are GLOBAL actions (not EDIT_MODE_CM) — name the context so the
  // lookup resolves the right registration.
  {precedence: 90, item: {id: 'undo', actionId: 'undo', context: ActionContextTypes.GLOBAL}},
  {precedence: 100, item: {id: 'redo', actionId: 'redo', context: ActionContextTypes.GLOBAL}},
  {precedence: 1000, item: {id: 'done', actionId: EXIT_EDIT_ACTION_ID}},
]
