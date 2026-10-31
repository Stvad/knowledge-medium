import {PencilLine} from 'lucide-react'
import {exitEditModeForBlock} from '@/data/properties.js'
import {ActionContextTypes, type ActionConfig} from '@/shortcuts/types.js'
import {showInfo} from '@/utils/toast.js'
import {captureAnchor} from './anchor.ts'
import {onOutline, rangeFromEditor, type ContentRange} from './actions.ts'
import {openComposer, viewKey} from './uiStore.ts'

export const SUGGEST_EDIT_ACTION_ID = 'annotations.suggestEdit'

/** Open the suggestion composer on a raw range of `targetId`'s content,
 *  widened to whole reference spans, with the replacement prefilled with the
 *  quote. False for an empty range, which has nothing to replace. Every
 *  trigger that can name a range of the text suggests through this. */
export const openSuggestionComposer = (
  targetId: string,
  renderScopeId: string | undefined,
  {content, from, to}: ContentRange,
): boolean => {
  const anchor = captureAnchor(content, from, to)
  if (!anchor) return false
  openComposer(viewKey(renderScopeId, targetId), targetId, anchor, {replacement: anchor.quote})
  return true
}

/** Comment on a selection's flow, with a replacement: the editor's selection,
 *  flushed, is the range. Outline blocks only, where the composer renders. */
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
    if (!openSuggestionComposer(deps.block.id, deps.renderScopeId, rangeFromEditor(deps.editorView))) {
      showInfo('Select the text to suggest a change to.')
      return
    }
    // As for a comment: the editor must not stay mounted behind the composer.
    void exitEditModeForBlock(deps.uiStateBlock, deps.block.id, deps.renderScopeId)
  },
}
