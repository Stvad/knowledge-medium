import type {EditorView} from '@codemirror/view'
import {MessageSquarePlus, Highlighter} from 'lucide-react'
import {exitEditModeForBlock} from '@/data/properties.js'
import type {Repo} from '@/data/repo'
import {flushEditorContent} from '@/editor/contentFlush.js'
import {ActionContextTypes, type ActionConfig} from '@/shortcuts/types.js'
import {isPanelRenderScopeId} from '@/utils/renderScope.js'
import {showError, showInfo} from '@/utils/toast.js'
import {captureAnchor, type RangeAnchor} from './anchor.ts'
import {createThread, isThreadRefusal} from './threads.ts'
import {closeComposer, openComposer, peekComposer, updateComposer, viewKey} from './uiStore.ts'

export const COMMENT_ON_SELECTION_ACTION_ID = 'annotations.commentOnSelection'
export const HIGHLIGHT_SELECTION_ACTION_ID = 'annotations.highlightSelection'
export const COMMENT_ON_BLOCK_ACTION_ID = 'annotations.commentOnBlock'

/** The selection's anchor as the user sees it. The stored row lags the editor
 *  by its debounce, so the pending write is flushed first; it lands on the
 *  write lock ahead of the creating tx, whose exact check then reads it. */
export const anchorFromEditor = (view: EditorView): RangeAnchor | null => {
  flushEditorContent(view)
  const {from, to} = view.state.selection.main
  return captureAnchor(view.state.doc.toString(), from, to)
}

/** Write the composer's draft as a new thread. A target that changed under the
 *  selection keeps the composer open with its draft and the reason, so the
 *  user can reselect and submit again. A submit while one is in flight is
 *  refused: both would capture the same draft. */
export const submitComposer = async (repo: Repo, key: string): Promise<boolean> => {
  const composer = peekComposer(key)
  const comment = composer?.draft.trim()
  if (!composer || !comment || composer.submitting) return false
  updateComposer(key, {submitting: true})
  try {
    await createThread(repo, {targetId: composer.targetId, anchor: composer.anchor, comment})
  } catch (error) {
    if (isThreadRefusal(error)) {
      updateComposer(key, {error: error.message, submitting: false})
      return false
    }
    updateComposer(key, {submitting: false})
    throw error
  }
  closeComposer(key)
  return true
}

/** The composer renders under outline blocks only, so the gestures run only
 *  there: in a backlinks entry, an embed or a comment card they would open a
 *  composer nothing shows. */
const onOutline = ({renderScopeId}: {renderScopeId?: string}): boolean =>
  renderScopeId === undefined || isPanelRenderScopeId(renderScopeId)

const NOT_ON_OUTLINE = 'Open the block in its page to comment on it.'

const commentOnSelection: ActionConfig<typeof ActionContextTypes.EDIT_MODE_CM> = {
  id: COMMENT_ON_SELECTION_ACTION_ID,
  description: 'Comment on selection',
  context: ActionContextTypes.EDIT_MODE_CM,
  icon: MessageSquarePlus,
  defaultBinding: {keys: '$mod+Alt+m'},
  isVisible: onOutline,
  handler: deps => {
    if (!onOutline(deps)) {
      showInfo(NOT_ON_OUTLINE)
      return
    }
    openComposer(viewKey(deps.renderScopeId, deps.block.id), deps.block.id, anchorFromEditor(deps.editorView))
    // The anchor is captured; leave edit mode so the editor does not stay
    // mounted behind the composer, where keys typed after it closes would
    // still reach it (a bare Enter would split the block at the quote).
    void exitEditModeForBlock(deps.uiStateBlock, deps.block.id, deps.renderScopeId)
  },
}

const highlightSelection: ActionConfig<typeof ActionContextTypes.EDIT_MODE_CM> = {
  id: HIGHLIGHT_SELECTION_ACTION_ID,
  description: 'Highlight selection',
  context: ActionContextTypes.EDIT_MODE_CM,
  icon: Highlighter,
  isVisible: onOutline,
  handler: async ({block, editorView, renderScopeId}) => {
    if (!onOutline({renderScopeId})) {
      showInfo(NOT_ON_OUTLINE)
      return
    }
    const anchor = anchorFromEditor(editorView)
    if (!anchor) {
      showInfo('Select some text to highlight.')
      return
    }
    try {
      await createThread(block.repo, {targetId: block.id, anchor})
    } catch (error) {
      if (isThreadRefusal(error)) showError(error.message)
      else throw error
    }
  },
}

const commentOnBlock: ActionConfig<typeof ActionContextTypes.NORMAL_MODE> = {
  id: COMMENT_ON_BLOCK_ACTION_ID,
  description: 'Comment on block',
  context: ActionContextTypes.NORMAL_MODE,
  icon: MessageSquarePlus,
  defaultBinding: {keys: '$mod+Alt+m'},
  isVisible: onOutline,
  handler: deps => {
    if (!onOutline(deps)) {
      showInfo(NOT_ON_OUTLINE)
      return
    }
    openComposer(viewKey(deps.renderScopeId, deps.block.id), deps.block.id, null)
  },
}

export const annotationActions: readonly ActionConfig[] = [commentOnSelection, highlightSelection, commentOnBlock]
