import type { Block } from '@/data/block'
import {
  editorSelection,
  focusBlock,
  requestEditorFocus,
  topLevelBlockIdProp,
  uiStateRenderScopeId,
} from '@/data/properties.js'
import { goBackInPanel, navigateInPanel, panelHistory } from '@/utils/panelHistory'
import { VIDEO_NOTES_VIEW_MODE } from './view.ts'

const focusVideoNoteChild = async (
  noteId: string,
  uiStateBlock: Block,
  renderScopeId?: string,
): Promise<void> => {
  await focusBlock(uiStateBlock, noteId, {
    edit: !uiStateBlock.repo.isReadOnly,
    renderScopeId,
  })
  await uiStateBlock.set(editorSelection, {blockId: noteId, start: 0})

  if (uiStateBlock.repo.isReadOnly) return

  // Ensure a newly mounted editor receives focus even if edit mode was
  // already active before notes view opened.
  requestEditorFocus(uiStateBlock)
}

export const focusVideoNote = async (
  videoBlock: Block,
  uiStateBlock: Block,
  renderScopeId?: string,
  preferredNoteId?: string,
): Promise<string | null> => {
  const childIds = await videoBlock.childIds.load()
  const noteId = preferredNoteId && childIds.includes(preferredNoteId)
    ? preferredNoteId
    : childIds[0]

  if (noteId) {
    await focusVideoNoteChild(noteId, uiStateBlock, renderScopeId)
    return noteId
  }

  return ensureEditableVideoNoteChild(videoBlock, uiStateBlock, renderScopeId)
}

export const ensureEditableVideoNoteChild = async (
  videoBlock: Block,
  uiStateBlock: Block,
  renderScopeId?: string,
): Promise<string | null> => {
  if (videoBlock.repo.isReadOnly) return null

  const childIds = await videoBlock.childIds.load()
  if (childIds.length > 0) return null

  const newId = await videoBlock.repo.mutate.createChild({
    parentId: videoBlock.id,
    position: {kind: 'first'},
  }) as string

  if (!newId) return null

  await focusVideoNoteChild(newId, uiStateBlock, renderScopeId)
  return newId
}

/** Enter the video-notes view: put the PANE into the mode. Same-block enter
 *  (the pane already shows the video) is a mode-only tx; a nested-video
 *  enter navigates the pane to the video AND sets the mode in one tx — one
 *  projection push, one history entry stamped `viewModeEnter` (which is what
 *  lets `closeVideoNotesView` go BACK instead of stranding the pane).
 *
 *  The gesture also seeds the first note child (gesture-side only — the
 *  RENDERER never writes; its empty-state affordance calls
 *  `ensureEditableVideoNoteChild` on activation instead).
 *
 *  `uiStateBlock` is the panel row in panel contexts (`getUIStateBlock`);
 *  on a non-panel surface there is no pane to put into the mode → no-op. */
export const enterVideoNotesView = async (
  videoBlock: Block,
  uiStateBlock: Block,
): Promise<void> => {
  if (uiStateBlock.peekProperty(topLevelBlockIdProp) === undefined) return
  await navigateInPanel(uiStateBlock, videoBlock.id, {viewMode: VIDEO_NOTES_VIEW_MODE})
  await ensureEditableVideoNoteChild(
    videoBlock,
    uiStateBlock,
    // The pane now renders the video top-level — focus the note in the
    // pane's own scope, not whatever scope the enter gesture came from.
    uiStateRenderScopeId(uiStateBlock, videoBlock.id),
  )
}

/** Close the video-notes view. If the top back entry carries the
 *  `viewModeEnter` marker, this pane ENTERED via a navigation — go back,
 *  restoring the pre-enter content (the entry's VisitState clears the
 *  mode). Otherwise (same-block enter, or a URL-borne mode) just clear the
 *  mode in place. */
// Re-entry guard: a double-activation of close (double-click, repeated key)
// must not step back twice. Keyed per panel; cleared when the first close
// settles.
const closingPanels = new Set<string>()

export const closeVideoNotesView = async (panelBlock: Block): Promise<void> => {
  if (closingPanels.has(panelBlock.id)) return
  closingPanels.add(panelBlock.id)
  try {
    const backTop = panelHistory.getSnapshot(panelBlock.id).back.at(-1)
    if (backTop?.viewModeEnter === VIDEO_NOTES_VIEW_MODE) {
      await goBackInPanel(panelBlock)
      return
    }
    const current = panelBlock.peekProperty(topLevelBlockIdProp)
    if (!current) return
    // Same-block with an EXPLICIT undefined mode: navigateInPanel's
    // same-block branch is presence-gated, so this is the clear-only tx.
    await navigateInPanel(panelBlock, current, {viewMode: undefined})
  } finally {
    closingPanels.delete(panelBlock.id)
  }
}
