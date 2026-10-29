import type {EditorView} from '@codemirror/view'
import {MessageSquarePlus, Highlighter} from 'lucide-react'
import type {Repo} from '@/data/repo'
import {flushEditorContent} from '@/editor/contentFlush.js'
import {ActionContextTypes, type ActionConfig} from '@/shortcuts/types.js'
import {showError, showInfo} from '@/utils/toast.js'
import {captureAnchor, type RangeAnchor} from './anchor.ts'
import {AnchorChangedError, createThread, UnannotatableTargetError} from './threads.ts'
import {closeComposer, openComposer, peekComposer, updateComposer} from './uiStore.ts'

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
 *  user can reselect and submit again. */
export const submitComposer = async (repo: Repo, targetId: string): Promise<boolean> => {
  const composer = peekComposer(targetId)
  const comment = composer?.draft.trim()
  if (!composer || !comment) return false
  try {
    await createThread(repo, {targetId, anchor: composer.anchor, comment})
  } catch (error) {
    if (error instanceof AnchorChangedError || error instanceof UnannotatableTargetError) {
      updateComposer(targetId, {error: error.message})
      return false
    }
    throw error
  }
  closeComposer(targetId)
  return true
}

const commentOnSelection: ActionConfig<typeof ActionContextTypes.EDIT_MODE_CM> = {
  id: COMMENT_ON_SELECTION_ACTION_ID,
  description: 'Comment on selection',
  context: ActionContextTypes.EDIT_MODE_CM,
  icon: MessageSquarePlus,
  defaultBinding: {keys: '$mod+Alt+m'},
  handler: ({block, editorView}) => {
    openComposer(block.id, anchorFromEditor(editorView))
  },
}

const highlightSelection: ActionConfig<typeof ActionContextTypes.EDIT_MODE_CM> = {
  id: HIGHLIGHT_SELECTION_ACTION_ID,
  description: 'Highlight selection',
  context: ActionContextTypes.EDIT_MODE_CM,
  icon: Highlighter,
  handler: async ({block, editorView}) => {
    const anchor = anchorFromEditor(editorView)
    if (!anchor) {
      showInfo('Select some text to highlight.')
      return
    }
    try {
      await createThread(block.repo, {targetId: block.id, anchor})
    } catch (error) {
      if (error instanceof AnchorChangedError || error instanceof UnannotatableTargetError) showError(error.message)
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
  handler: ({block}) => {
    openComposer(block.id, null)
  },
}

export const annotationActions: readonly ActionConfig[] = [commentOnSelection, highlightSelection, commentOnBlock]
