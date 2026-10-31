import type {EditorView} from '@codemirror/view'
import {MessageSquarePlus, Highlighter, PanelRight, TextQuote, type LucideIcon} from 'lucide-react'
import {Block} from '@/data/block'
import {exitEditModeForBlock} from '@/data/properties.js'
import {BLOCK_SHELL_ATTRIBUTE} from '@/extensions/blockInteraction.js'
import type {Repo} from '@/data/repo'
import {getLayoutSessionBlock} from '@/data/stateBlocks.js'
import {flushEditorContent} from '@/editor/contentFlush.js'
import {ENTER_BLOCK_EDIT_MODE_ACTION_ID} from '@/plugins/plain-outliner/clickToEditAction.js'
import type {ActionDispatchDecorator} from '@/shortcuts/actionDispatch.js'
import {
  ActionContextTypes,
  type ActionConfig,
  type ActionContextConfig,
  type BaseShortcutDependencies,
  type BlockPointerDependencies,
  type CodeMirrorEditModeDependencies,
} from '@/shortcuts/types.js'
import {writeTextToClipboard} from '@/utils/copy.js'
import {resolveActivePanelRow} from '@/utils/navigation.js'
import {isPanelRenderScopeId} from '@/utils/renderScope.js'
import {showError, showInfo} from '@/utils/toast.js'
import {captureAnchor, type RangeAnchor} from './anchor.ts'
import {annotationMarginOpenProp} from './marginSchema.ts'
import {threadForRange} from './rangeRefs.ts'
import {holdsSelection, locateReadSelection, mapReadSelection, type SelectionEnds} from './readSelection.ts'
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
export const COPY_REFERENCE_TO_SELECTION_ACTION_ID = 'annotations.copyReferenceToSelection'
export const COMMENT_ON_BLOCK_ACTION_ID = 'annotations.commentOnBlock'
export const COMMENT_ON_READ_SELECTION_ACTION_ID = 'annotations.commentOnReadSelection'
export const HIGHLIGHT_READ_SELECTION_ACTION_ID = 'annotations.highlightReadSelection'
export const COPY_REFERENCE_TO_READ_SELECTION_ACTION_ID = 'annotations.copyReferenceToReadSelection'
export const TOGGLE_MARGIN_ACTION_ID = 'annotations.toggleMargin'

/** One chord per gesture, the same in every mode it runs in. Control+Shift
 *  rather than the platform modifier: macOS and the browsers reserve much of
 *  ⌘⌥ and ⌘⇧ (⌘⌥M minimizes every window), and on Windows Ctrl+Alt is AltGr. */
const COMMENT_KEYS = 'Control+Shift+Slash'
const HIGHLIGHT_KEYS = 'Control+Shift+h'

/** Home of the gestures on text selected in rendered (not edited) block
 *  content, where no editor holds a selection to read. Always active; each
 *  gesture dispatches only while such a selection exists, read from the DOM as
 *  the key arrives rather than tracked, so a fast keypress after the selection
 *  is not lost. Above a focused block's normal mode, so the selection wins
 *  over the block it sits in. */
export const READ_SELECTION_CONTEXT = 'annotations.read-selection'

export const readSelectionContext: ActionContextConfig = {
  type: READ_SELECTION_CONTEXT,
  displayName: 'Text selected in rendered blocks',
  priority: 'high',
  validateDependencies: (deps): deps is BaseShortcutDependencies =>
    typeof deps === 'object' && deps !== null && (deps as BaseShortcutDependencies).uiStateBlock instanceof Block,
}

/** A raw range of a block's content: what an editor selection maps to, and
 *  what any other trigger that can name a range of the text hands over. */
export interface ContentRange {
  content: string
  from: number
  to: number
}

/** The editor's selection as the user sees it. The stored row lags the
 *  editor by its debounce, so the pending write is flushed first; it lands on
 *  the write lock ahead of the creating tx, whose exact check then reads it. */
export const rangeFromEditor = (view: EditorView): ContentRange => {
  flushEditorContent(view)
  const {from, to} = view.state.selection.main
  return {content: view.state.doc.toString(), from, to}
}

/** Widened to whole reference spans; null for an empty range, which comments
 *  on the whole block. */
export const anchorOf = ({content, from, to}: ContentRange): RangeAnchor | null => captureAnchor(content, from, to)

export const anchorFromEditor = (view: EditorView): RangeAnchor | null => anchorOf(rangeFromEditor(view))

/** A failure the user should see, as a toast. */
export const reportFailure = (error: unknown): void => {
  showError(error instanceof Error ? error.message : String(error))
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

/** The thread waiting for new text in this block (Reselect on its card), if
 *  any. It takes the selection wherever the block is edited, a comment's
 *  editor inside a card included, since no composer opens for it. */
const pendingReanchorIn = ({block}: {block: {id: string}}) => {
  const pending = peekPendingReanchor()
  return pending?.targetId === block.id ? pending : null
}

/** What a gesture annotates: the block, the render scope the selection was
 *  made in, and the selected range of the block's text. The editor and a
 *  read-mode selection each produce one, and the steps below are the one path
 *  from there to a thread. */
export interface SelectionTarget {
  block: Block
  renderScopeId: string | undefined
  range: ContentRange
}

/** Open a composer on the target, or move the thread waiting for new text in
 *  its block there instead. True when a composer opened. */
export const commentOnTarget = async (target: SelectionTarget): Promise<boolean> => {
  const {block, renderScopeId} = target
  const anchor = anchorOf(target.range)
  const pending = pendingReanchorIn(target)
  if (pending) {
    await reanchorToSelection(block.repo, pending.threadId, anchor)
    return false
  }
  if (!onOutline(target)) {
    showInfo(NOT_ON_OUTLINE)
    return false
  }
  openComposer(viewKey(renderScopeId, block.id), block.id, anchor)
  return true
}

/** A thread with no comments on the target's text. True when it was made. */
export const highlightTarget = async (target: SelectionTarget): Promise<boolean> => {
  if (!onOutline(target)) {
    showInfo(NOT_ON_OUTLINE)
    return false
  }
  const {block} = target
  const anchor = anchorOf(target.range)
  if (!anchor) {
    showInfo('Select some text to highlight.')
    return false
  }
  try {
    await createThread(block.repo, {targetId: block.id, anchor})
    return true
  } catch (error) {
    if (isThreadRefusal(error)) {
      showError(error.message)
      return false
    }
    throw error
  }
}

/** Put `((T))` on the clipboard, T the thread that highlights the target's
 *  text, made here when there is none. It opens no composer, so unlike the
 *  steps above it runs wherever the block shows: an embed, a backlink entry,
 *  a comment in a card. True once the reference is copied. */
export const copyReferenceToTarget = async ({block, range}: SelectionTarget): Promise<boolean> => {
  const anchor = anchorOf(range)
  if (!anchor) {
    showInfo('Select the text to quote.')
    return false
  }
  let threadId: string
  try {
    threadId = await threadForRange(block.repo, block.id, anchor, range.content)
  } catch (error) {
    if (isThreadRefusal(error)) {
      showError(error.message)
      return false
    }
    throw error
  }
  try {
    await writeTextToClipboard(`((${threadId}))`)
  } catch {
    // The highlight stays, and the next copy of this range reuses it.
    showError('The browser refused to write to the clipboard. Try again.')
    return false
  }
  showInfo('Copied a reference to the selection.')
  return true
}

/** A thread waiting for new text (Reselect on its card) takes the selection
 *  instead of a new comment. A refusal keeps it waiting, so the user can
 *  select again. */
const reanchorToSelection = async (repo: Repo, threadId: string, anchor: RangeAnchor | null): Promise<void> => {
  if (!anchor) {
    showInfo('Select the text to move the comment to.')
    return
  }
  try {
    await reanchorThread(repo, threadId, anchor)
    startReanchor(null)
    showInfo('Moved the comment to the selection.')
  } catch (error) {
    if (isThreadRefusal(error)) showError(error.message)
    else throw error
  }
}

const editorTarget = ({block, renderScopeId, editorView}: CodeMirrorEditModeDependencies): SelectionTarget =>
  ({block, renderScopeId, range: rangeFromEditor(editorView)})

const commentOnSelection: ActionConfig<typeof ActionContextTypes.EDIT_MODE_CM> = {
  id: COMMENT_ON_SELECTION_ACTION_ID,
  description: 'Comment on selection',
  context: ActionContextTypes.EDIT_MODE_CM,
  icon: MessageSquarePlus,
  defaultBinding: {keys: COMMENT_KEYS},
  isVisible: deps => pendingReanchorIn(deps) !== null || onOutline(deps),
  handler: async deps => {
    if (!await commentOnTarget(editorTarget(deps))) return
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
  defaultBinding: {keys: HIGHLIGHT_KEYS},
  isVisible: onOutline,
  handler: async deps => { await highlightTarget(editorTarget(deps)) },
}

const copyReferenceToSelection: ActionConfig<typeof ActionContextTypes.EDIT_MODE_CM> = {
  id: COPY_REFERENCE_TO_SELECTION_ACTION_ID,
  description: 'Copy reference to selection',
  context: ActionContextTypes.EDIT_MODE_CM,
  icon: TextQuote,
  handler: async deps => { await copyReferenceToTarget(editorTarget(deps)) },
}

const commentOnBlock: ActionConfig<typeof ActionContextTypes.NORMAL_MODE> = {
  id: COMMENT_ON_BLOCK_ACTION_ID,
  description: 'Comment on block',
  context: ActionContextTypes.NORMAL_MODE,
  icon: MessageSquarePlus,
  defaultBinding: {keys: COMMENT_KEYS},
  isVisible: onOutline,
  handler: deps => {
    if (!onOutline(deps)) {
      showInfo(NOT_ON_OUTLINE)
      return
    }
    openComposer(viewKey(deps.renderScopeId, deps.block.id), deps.block.id, null)
  },
}

/** The read-mode selection as a target, or why it can't be one: it spans
 *  blocks, or an end of it can't be placed exactly in the block's text. Null
 *  when nothing is selected in rendered content. */
export const readSelectionTarget = (repo: Repo, ends: SelectionEnds | null): SelectionTarget | string | null => {
  const selection = mapReadSelection(ends, id => repo.block(id).peek()?.content)
  if (!selection) return null
  if (selection.kind === 'several') return 'Select text within one block.'
  if (selection.kind === 'inexact') {
    return 'Can’t tell exactly which text that is. Start and end the selection in plain text, not inside a link, reference or code.'
  }
  const {blockId, renderScopeId, content, from, to} = selection
  // A selection the user can see, all of it outside the text (an image, say),
  // would otherwise read as no range: a comment on the whole block.
  if (from === to) return 'Select some text first.'
  return {block: repo.block(blockId), renderScopeId, range: {content, from, to}}
}

/** Run `step` on a read-mode target, or show why it can't. The selection is
 *  cleared once the step lands, so it doesn't sit over the new highlight. */
export const runOnReadTarget = async (
  target: SelectionTarget | string | null,
  step: (target: SelectionTarget) => Promise<boolean>,
): Promise<void> => {
  if (typeof target === 'string') showInfo(target)
  else if (target && await step(target)) document.getSelection()?.removeAllRanges()
}

/** The gestures a read-mode selection offers, as shortcuts and as its
 *  context menu. */
export interface ReadSelectionGesture {
  actionId: string
  /** On the context menu. */
  label: string
  /** In the command palette and the keybindings editor. */
  description: string
  icon: LucideIcon
  keys?: string
  step: (target: SelectionTarget) => Promise<boolean>
}

export const readSelectionGestures: readonly ReadSelectionGesture[] = [
  {
    actionId: COMMENT_ON_READ_SELECTION_ACTION_ID, label: 'Comment', description: 'Comment selection',
    icon: MessageSquarePlus, keys: COMMENT_KEYS, step: commentOnTarget,
  },
  {
    actionId: HIGHLIGHT_READ_SELECTION_ACTION_ID, label: 'Highlight', description: 'Highlight selection',
    icon: Highlighter, keys: HIGHLIGHT_KEYS, step: highlightTarget,
  },
  {
    actionId: COPY_REFERENCE_TO_READ_SELECTION_ACTION_ID, label: 'Copy reference', description: 'Copy reference to selection',
    icon: TextQuote, step: copyReferenceToTarget,
  },
]

/** The click that ends a drag-select in rendered content would enter edit
 *  mode and swap the selected text for an editor. While the clicked block
 *  holds a selection the click does nothing; the next click, which collapses
 *  it, edits. */
export const keepSelectionOnClick: ActionDispatchDecorator = {
  actionId: ENTER_BLOCK_EDIT_MODE_ACTION_ID,
  context: ActionContextTypes.BLOCK_POINTER,
  wrap: (deps, trigger, next) => {
    const shell = (deps as BlockPointerDependencies).targetElement.closest(`[${BLOCK_SHELL_ATTRIBUTE}]`)
    return shell && holdsSelection(shell) ? undefined : next(deps, trigger)
  },
}

/** Across blocks too, so the gesture refuses out loud rather than letting the
 *  chord fall through to nothing. */
const hasReadSelection = (): boolean => locateReadSelection(document.getSelection()) !== null

const readSelectionActions: readonly ActionConfig[] = readSelectionGestures.map(gesture => ({
  id: gesture.actionId,
  description: gesture.description,
  context: READ_SELECTION_CONTEXT,
  icon: gesture.icon,
  defaultBinding: gesture.keys === undefined ? undefined : {keys: gesture.keys},
  isVisible: hasReadSelection,
  canDispatch: hasReadSelection,
  handler: ({uiStateBlock}: BaseShortcutDependencies) =>
    runOnReadTarget(readSelectionTarget(uiStateBlock.repo, document.getSelection()), gesture.step),
}))

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

export const annotationActions: readonly ActionConfig[] = [
  commentOnSelection, highlightSelection, copyReferenceToSelection, commentOnBlock, ...readSelectionActions, toggleMargin,
]
