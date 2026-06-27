import {
  IndentDecrease,
  IndentIncrease,
  ArrowUp,
  ArrowDown,
  Undo2,
  Redo2,
  KeyboardOff,
} from 'lucide-react'
import { EXIT_EDIT_ACTION_ID, type MobileKeyboardToolbarItem } from './facet.ts'
import {
  INSERT_BLOCK_REF_TRIGGER_ACTION_ID,
  INSERT_PAGE_REF_TRIGGER_ACTION_ID,
} from './actions.ts'

/** The toolbar's own buttons — the structural / reference / undo / done set.
 *  Other plugins contribute their buttons to the same facet (attachments' image,
 *  todo's toggle); the `precedence` they register with slots them in among these. */
export const defaultToolbarItems: readonly MobileKeyboardToolbarItem[] = [
  {kind: 'icon', id: 'outdent', actionId: 'edit.cm.outdent_block', label: 'Outdent', icon: IndentDecrease},
  {kind: 'icon', id: 'indent', actionId: 'edit.cm.indent_block', label: 'Indent', icon: IndentIncrease},
  {kind: 'text', id: 'page-ref', actionId: INSERT_PAGE_REF_TRIGGER_ACTION_ID, label: 'Page reference', text: '[['},
  {kind: 'text', id: 'block-ref', actionId: INSERT_BLOCK_REF_TRIGGER_ACTION_ID, label: 'Block reference', text: '(('},
  {kind: 'icon', id: 'move-up', actionId: 'move_block_up_cm', label: 'Move up', icon: ArrowUp},
  {kind: 'icon', id: 'move-down', actionId: 'move_block_down_cm', label: 'Move down', icon: ArrowDown},
  {kind: 'icon', id: 'undo', actionId: 'undo', label: 'Undo', icon: Undo2},
  {kind: 'icon', id: 'redo', actionId: 'redo', label: 'Redo', icon: Redo2},
  {kind: 'icon', id: 'done', actionId: EXIT_EDIT_ACTION_ID, label: 'Done', icon: KeyboardOff},
]

/** Precedence per default item id (ascending = earlier). Gaps leave room for
 *  plugin buttons: attachments' image at 50 (between block-ref and move-up),
 *  todo's toggle at 60. "Done" is pinned last. */
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
