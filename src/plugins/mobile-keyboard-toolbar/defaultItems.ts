import { ActionContextTypes } from '@/shortcuts/types.js'
import type { MobileKeyboardToolbarItem } from './facet.ts'
import {
  INSERT_BLOCK_REF_TRIGGER_ACTION_ID,
  INSERT_PAGE_REF_TRIGGER_ACTION_ID,
} from './actions.ts'

/** The toolbar's own buttons — the structural / reference / undo / done set.
 *  Each is a reference to an action; the glyph + label come from the action.
 *  Other plugins contribute their buttons to the same facet (attachments'
 *  image); the `precedence` they register with slots them in among these. */
export const defaultToolbarItems: readonly MobileKeyboardToolbarItem[] = [
  {id: 'outdent', actionId: 'edit.cm.outdent_block'},
  {id: 'indent', actionId: 'edit.cm.indent_block'},
  {id: 'page-ref', actionId: INSERT_PAGE_REF_TRIGGER_ACTION_ID},
  {id: 'block-ref', actionId: INSERT_BLOCK_REF_TRIGGER_ACTION_ID},
  {id: 'move-up', actionId: 'move_block_up_cm'},
  {id: 'move-down', actionId: 'move_block_down_cm'},
  // undo/redo are GLOBAL actions (not EDIT_MODE_CM) — name the context so the
  // lookup resolves the right registration.
  {id: 'undo', actionId: 'undo', context: ActionContextTypes.GLOBAL},
  {id: 'redo', actionId: 'redo', context: ActionContextTypes.GLOBAL},
  {id: 'done', actionId: 'exit_edit_mode_cm'},
]

/** Precedence per default item id (ascending = earlier). The gap at 50 leaves
 *  room for the attachments image button between block-ref and move-up. "Done"
 *  is pinned last. */
export const DEFAULT_ITEM_PRECEDENCE: Readonly<Record<string, number>> = {
  outdent: 10,
  indent: 20,
  'page-ref': 30,
  'block-ref': 40,
  'move-up': 70,
  'move-down': 80,
  undo: 90,
  redo: 100,
  done: 1000,
}
