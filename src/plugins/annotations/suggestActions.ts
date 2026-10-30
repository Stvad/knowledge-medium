import {PencilLine} from 'lucide-react'
import {exitEditModeForBlock} from '@/data/properties.js'
import {ActionContextTypes, type ActionConfig} from '@/shortcuts/types.js'
import {showInfo} from '@/utils/toast.js'
import {anchorFromEditor, onOutline} from './actions.ts'
import {openComposer, viewKey} from './uiStore.ts'

export const SUGGEST_EDIT_ACTION_ID = 'annotations.suggestEdit'

/** Comment on a selection's flow, with a replacement: the selection is flushed
 *  and widened to whole reference spans, and the composer opens with the
 *  replacement prefilled with the selected text. Outline blocks only, where
 *  the composer renders. */
export const suggestEditAction: ActionConfig<typeof ActionContextTypes.EDIT_MODE_CM> = {
  id: SUGGEST_EDIT_ACTION_ID,
  description: 'Suggest edit to selection',
  context: ActionContextTypes.EDIT_MODE_CM,
  icon: PencilLine,
  isVisible: onOutline,
  handler: async deps => {
    if (!onOutline(deps)) {
      showInfo('Open the block in its page to suggest an edit to it.')
      return
    }
    const anchor = anchorFromEditor(deps.editorView)
    if (!anchor) {
      showInfo('Select the text to suggest a change to.')
      return
    }
    openComposer(viewKey(deps.renderScopeId, deps.block.id), deps.block.id, anchor, {replacement: anchor.quote})
    // As for a comment: the editor must not stay mounted behind the composer.
    void exitEditModeForBlock(deps.uiStateBlock, deps.block.id, deps.renderScopeId)
  },
}
