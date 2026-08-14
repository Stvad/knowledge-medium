import type { Block } from '@/data/block'
import {
  editorSelection,
  focusBlock,
  requestEditorFocus,
  topLevelBlockIdProp,
} from '@/data/properties.js'
import { panelRenderScopeId } from '@/utils/renderScope'
import { goBackInPanel, navigateInPanel, panelHistory } from '@/utils/panelHistory'
import { prepareExclusiveMaximize } from '@/utils/panelLayoutProjection'
import { isMobileViewport } from '@/utils/viewport'
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

/** Enter the video-notes view: put the PANE into the mode AND maximize it.
 *  Same-block enter (the pane already shows the video) is a state-only tx; a
 *  nested-video enter navigates the pane to the video AND sets both keys in
 *  one tx — one projection push, one history entry stamped `viewModeEnter`
 *  (which is what lets `closeVideoNotesView` go BACK instead of stranding the
 *  pane).
 *
 *  Maximizing is the default because the notes view is an immersion gesture:
 *  pane-scoping it (design §4.3) otherwise gave the video only its column in a
 *  split, which is strictly worse than the fullscreen overlay it replaced. The
 *  two are independent keys (`;view=video-notes;max`) so the generic
 *  `toggle_maximize_panel` still un-maximizes without leaving notes view.
 *
 *  `prepareExclusiveMaximize` decides whether maximizing is warranted at all:
 *  with a lone pane, or a viewport that renders one pane regardless, there is
 *  nothing to hide, and setting the flag anyway leaves state that renders
 *  identically, offers no restore button, survives an ordinary in-pane
 *  navigation away from the notes view, and then swallows the next pane the
 *  user opens. It also clears any OTHER flagged pane, which
 *  is what keeps the at-most-one rule true for this writer — the flag itself
 *  is set from inside `navigateInPanel`'s tx, below the layer that can see a
 *  session's rows.
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
  const maximized = await prepareExclusiveMaximize(uiStateBlock.repo, uiStateBlock.id, {
    canRenderSplit: !isMobileViewport(),
  })
  await navigateInPanel(uiStateBlock, videoBlock.id, {
    viewMode: VIDEO_NOTES_VIEW_MODE,
    // Declining is arrangement-NEUTRAL, so the key is omitted rather than sent
    // as `false`: passing `false` would clear a maximize this pane already
    // carried, silently undoing a deliberate one when the gesture merely had
    // nothing to add (a narrow viewport, or a lone pane).
    ...(maximized ? {maximized: true} : {}),
  })
  await ensureEditableVideoNoteChild(
    videoBlock,
    uiStateBlock,
    // The pane now renders the video top-level — focus the note in the
    // pane's own scope, not whatever scope the enter gesture came from.
    // Derived directly (panel id + the block we just navigated to), with no
    // temporal dependency on the freshly-committed topLevelBlockIdProp peek.
    panelRenderScopeId(uiStateBlock.id, videoBlock.id),
  )
}

/** Close the video-notes view. If the top back entry carries the
 *  `viewModeEnter` marker, this pane ENTERED via a navigation — go back,
 *  restoring the pre-enter content (the entry's VisitState clears the
 *  mode). Otherwise (same-block enter, or a URL-borne mode) just clear the
 *  mode in place.
 *
 *  Either way it also un-maximizes, in the SAME tx as the mode clear: close
 *  undoes the keys enter set, and leaving the pane maximized would keep every
 *  sibling pane hidden after the view the maximize existed for is gone. This
 *  does drop a maximize the user had set MANUALLY before entering notes —
 *  accepted, since enter maximizes whenever there is anything to hide and
 *  nothing records which of the two set it. */
// Re-entry guard: a double-activation of close (double-click, repeated key)
// must not step back twice. Keyed per panel; cleared when the first close
// settles.
const closingPanels = new Set<string>()

export const closeVideoNotesView = async (panelBlock: Block): Promise<void> => {
  if (closingPanels.has(panelBlock.id)) return
  closingPanels.add(panelBlock.id)
  try {
    const backTop = panelHistory.getSnapshot(panelBlock.id).back.at(-1)
    // Only go back if the MARKED pre-enter page is still live. `goBackInPanel`
    // prunes dead entries rather than landing on a tombstone, so a deleted
    // pre-enter page would otherwise make close either do nothing (no live
    // entry left — pane stuck in video-notes mode) or silently jump to some
    // older, unrelated page. Neither is "close the notes view"; clearing the
    // mode in place is.
    if (backTop?.viewModeEnter === VIDEO_NOTES_VIEW_MODE
      && await panelBlock.repo.exists(backTop.blockId)
      && await goBackInPanel(panelBlock, {maximized: false})) {
      return
    }
    const current = panelBlock.peekProperty(topLevelBlockIdProp)
    if (!current) return
    // Same-block with an EXPLICIT undefined mode: navigateInPanel's
    // same-block branch is presence-gated, so this is the clear-only tx.
    await navigateInPanel(panelBlock, current, {viewMode: undefined, maximized: false})
  } finally {
    closingPanels.delete(panelBlock.id)
  }
}
