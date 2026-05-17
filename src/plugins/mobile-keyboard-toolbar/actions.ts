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
  open: string,
  close: string,
) => {
  const {state} = editorView
  editorView.dispatch(state.changeByRange(range => {
    if (range.empty) {
      return {
        changes: {from: range.from, insert: `${open}${close}`},
        range: EditorSelection.cursor(range.from + open.length),
      }
    }

    const selectedText = state.sliceDoc(range.from, range.to)
    return {
      changes: {from: range.from, to: range.to, insert: `${open}${selectedText}${close}`},
      range: EditorSelection.range(range.from + open.length, range.to + open.length),
    }
  }))
  editorView.focus()
  startCompletion(editorView)
}

const completionTriggerAction = (
  id: string,
  description: string,
  open: string,
  close: string,
): ActionConfig<typeof ActionContextTypes.EDIT_MODE_CM> => ({
  id,
  description,
  context: ActionContextTypes.EDIT_MODE_CM,
  handler: async (deps) => {
    insertCompletionTrigger(deps.editorView, open, close)
  },
})

export const mobileKeyboardToolbarActions: readonly ActionConfig<typeof ActionContextTypes.EDIT_MODE_CM>[] = [
  completionTriggerAction(
    INSERT_PAGE_REF_TRIGGER_ACTION_ID,
    'Insert page reference trigger',
    '[[',
    ']]',
  ),
  completionTriggerAction(
    INSERT_BLOCK_REF_TRIGGER_ACTION_ID,
    'Insert block reference trigger',
    '((',
    '))',
  ),
]
