import { startCompletion } from '@codemirror/autocomplete'
import { EditorSelection } from '@codemirror/state'
import {
  ActionContextTypes,
  type ActionConfig,
  type CodeMirrorEditModeDependencies,
} from '@/shortcuts/types.ts'

export const INSERT_PAGE_REF_TRIGGER_ACTION_ID = 'edit.cm.insert_page_ref_trigger'
export const INSERT_BLOCK_REF_TRIGGER_ACTION_ID = 'edit.cm.insert_block_ref_trigger'

const insertCompletionTrigger = (
  editorView: CodeMirrorEditModeDependencies['editorView'],
  text: string,
) => {
  editorView.dispatch(editorView.state.changeByRange(range => ({
    changes: {from: range.from, to: range.to, insert: text},
    range: EditorSelection.cursor(range.from + text.length),
  })))
  editorView.focus()
  startCompletion(editorView)
}

const completionTriggerAction = (
  id: string,
  description: string,
  text: string,
): ActionConfig<typeof ActionContextTypes.EDIT_MODE_CM> => ({
  id,
  description,
  context: ActionContextTypes.EDIT_MODE_CM,
  handler: async (deps) => {
    insertCompletionTrigger(deps.editorView, text)
  },
})

export const mobileKeyboardToolbarActions: readonly ActionConfig<typeof ActionContextTypes.EDIT_MODE_CM>[] = [
  completionTriggerAction(
    INSERT_PAGE_REF_TRIGGER_ACTION_ID,
    'Insert page reference trigger',
    '[[',
  ),
  completionTriggerAction(
    INSERT_BLOCK_REF_TRIGGER_ACTION_ID,
    'Insert block reference trigger',
    '((',
  ),
]
