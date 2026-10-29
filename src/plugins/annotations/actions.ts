import type {EditorView} from '@codemirror/view'
import {MessageSquarePlus, Highlighter, PanelRight} from 'lucide-react'
import {exitEditModeForBlock} from '@/data/properties.js'
import type {Repo} from '@/data/repo'
import {getLayoutSessionBlock} from '@/data/stateBlocks.js'
import {flushEditorContent} from '@/editor/contentFlush.js'
import {ActionContextTypes, type ActionConfig} from '@/shortcuts/types.js'
import {resolveActivePanelRow} from '@/utils/navigation.js'
import {isPanelRenderScopeId} from '@/utils/renderScope.js'
import {showError, showInfo} from '@/utils/toast.js'
import {captureAnchor, type RangeAnchor} from './anchor.ts'
import {annotationMarginOpenProp} from './marginSchema.ts'
import {reanchorThread} from './reanchor.ts'
import {createThread, isThreadRefusal} from './threads.ts'
import {
  closeComposer,
  openComposer,
  peekComposer,
  peekPendingReanchor,
  startReanchor,
  updateComposer,
  viewKey,
} from './uiStore.ts'

export const COMMENT_ON_SELECTION_ACTION_ID = 'annotations.commentOnSelection'
export const HIGHLIGHT_SELECTION_ACTION_ID = 'annotations.highlightSelection'
export const COMMENT_ON_BLOCK_ACTION_ID = 'annotations.commentOnBlock'
export const TOGGLE_MARGIN_ACTION_ID = 'annotations.toggleMargin'

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
  handler: async deps => {
    if (!onOutline(deps)) {
      showInfo(NOT_ON_OUTLINE)
      return
    }
    const pending = peekPendingReanchor()
    if (pending?.targetId === deps.block.id) {
      await reanchorToSelection(deps.block.repo, pending.threadId, deps.editorView)
      return
    }
    openComposer(viewKey(deps.renderScopeId, deps.block.id), deps.block.id, anchorFromEditor(deps.editorView))
    // The anchor is captured; leave edit mode so the editor does not stay
    // mounted behind the composer, where keys typed after it closes would
    // still reach it (a bare Enter would split the block at the quote).
    void exitEditModeForBlock(deps.uiStateBlock, deps.block.id, deps.renderScopeId)
  },
}

/** A thread waiting for new text (Reselect on its card) takes the selection
 *  instead of a new comment. A refusal keeps it waiting, so the user can
 *  select again. */
const reanchorToSelection = async (repo: Repo, threadId: string, view: EditorView): Promise<void> => {
  const anchor = anchorFromEditor(view)
  if (!anchor) {
    showInfo('Select the text to move the comment to.')
    return
  }
  try {
    await reanchorThread(repo, threadId, anchor)
    startReanchor(null)
  } catch (error) {
    if (isThreadRefusal(error)) showError(error.message)
    else throw error
  }
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

/** Per panel: the active one, as global commands pick it. */
const toggleMargin: ActionConfig<typeof ActionContextTypes.GLOBAL> = {
  id: TOGGLE_MARGIN_ACTION_ID,
  description: 'Toggle comments margin',
  context: ActionContextTypes.GLOBAL,
  icon: PanelRight,
  handler: async ({uiStateBlock}) => {
    const repo = uiStateBlock.repo
    const panelRow = await resolveActivePanelRow(await getLayoutSessionBlock(uiStateBlock, repo.activeLayoutSessionId))
    if (!panelRow) return
    const panel = repo.block(panelRow.id)
    await panel.set(annotationMarginOpenProp, !panel.peekProperty(annotationMarginOpenProp))
  },
}

export const annotationActions: readonly ActionConfig[] = [commentOnSelection, highlightSelection, commentOnBlock, toggleMargin]
