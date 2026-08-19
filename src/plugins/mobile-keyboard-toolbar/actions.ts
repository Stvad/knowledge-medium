import { startCompletion } from '@codemirror/autocomplete'
import { Brackets, Parentheses } from 'lucide-react'
import {
  ActionContextTypes,
  type ActionConfig,
  type ActionIcon,
  type CodeMirrorEditModeDependencies,
} from '@/shortcuts/types.js'
import { wrapRangeWithPair } from '@/utils/codemirror.js'

export const INSERT_PAGE_REF_TRIGGER_ACTION_ID = 'edit.cm.insert_page_ref_trigger'
export const INSERT_BLOCK_REF_TRIGGER_ACTION_ID = 'edit.cm.insert_block_ref_trigger'

const insertCompletionTrigger = (
  editorView: CodeMirrorEditModeDependencies['editorView'],
  open: string,
  close: string,
) => {
  const {state} = editorView
  editorView.dispatch(state.changeByRange(range => wrapRangeWithPair(state, range, open, close)))
  editorView.focus()
  startCompletion(editorView)
}

const completionTriggerAction = (
  id: string,
  description: string,
  open: string,
  close: string,
  icon: ActionIcon,
): ActionConfig<typeof ActionContextTypes.EDIT_MODE_CM> => ({
  id,
  description,
  context: ActionContextTypes.EDIT_MODE_CM,
  // `Brackets` (`[ ]`) / `Parentheses` (`( )`) stand in for the `[[` / `((`
  // glyphs on the toolbar; surfaces that render actions (toolbar, palette) read
  // this rather than carrying their own presentation.
  icon,
  handler: async (deps) => {
    insertCompletionTrigger(deps.editorView, open, close)
  },
})

export const mobileKeyboardToolbarActions: readonly ActionConfig<typeof ActionContextTypes.EDIT_MODE_CM>[] = [
  completionTriggerAction(
    INSERT_PAGE_REF_TRIGGER_ACTION_ID,
    'Insert page reference',
    '[[',
    ']]',
    Brackets,
  ),
  completionTriggerAction(
    INSERT_BLOCK_REF_TRIGGER_ACTION_ID,
    'Insert block reference',
    '((',
    '))',
    Parentheses,
  ),
]
