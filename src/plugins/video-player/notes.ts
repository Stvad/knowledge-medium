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
  // CLAIMED, not "is maximized": false covers both a decline and a pane that
  // was already maximized, and those two want the same follow-up write.
  const claimedMaximize = await prepareExclusiveMaximize(uiStateBlock.repo, uiStateBlock.id, {
    canRenderSplit: !isMobileViewport(),
  })
  if (claimedMaximize) maximizedByNotesEnter.add(uiStateBlock.id)
  else maximizedByNotesEnter.delete(uiStateBlock.id)
  await navigateInPanel(uiStateBlock, videoBlock.id, {
    viewMode: VIDEO_NOTES_VIEW_MODE,
    // Not claiming is arrangement-NEUTRAL, so the key is omitted rather than
    // sent as `false`: passing `false` would clear a maximize this pane already
    // carried, silently undoing a deliberate one when the gesture merely had
    // nothing to add (a narrow viewport, a lone pane, or a pane the user had
    // already maximized — which needs no write to end up maximized).
    ...(claimedMaximize ? {maximized: true} : {}),
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
 *  Either way it also un-maximizes, in the SAME tx as the mode clear: leaving
 *  the pane maximized would keep every sibling hidden after the view the
 *  maximize existed for is gone — but ONLY a maximize this gesture's own enter
 *  set (tracked in `maximizedByNotesEnter`), so one the user set deliberately
 *  before entering notes survives the close. */
// Re-entry guard: a double-activation of close (double-click, repeated key)
// must not step back twice. Keyed per panel; cleared when the first close
// settles.
const closingPanels = new Set<string>()

/** Panes whose maximize was set BY the notes enter, so close knows whether the
 *  flag is its to clear. Without it, close erases a maximize the user set
 *  deliberately. Two ways in, and the second is the ordinary one:
 *  - the enter DECLINED (a lone pane, or a narrow viewport) on a pane that was
 *    already flagged;
 *  - the enter would have maximized, but the pane was ALREADY maximized —
 *    maximize a pane in a desktop split, then open notes in it. Membership
 *    here therefore tracks the TRANSITION, not "the pane ended up maximized";
 *    the two coincide only when the pane started unmaximized.
 *
 *  In-memory and device-local by the same reasoning as the `viewModeEnter`
 *  history marker: close-restores-arrangement is a session-scoped nicety, and
 *  losing it across a reload degrades to leaving the flag alone, which is the
 *  safe direction. */
const maximizedByNotesEnter = new Set<string>()

export const closeVideoNotesView = async (panelBlock: Block): Promise<void> => {
  if (closingPanels.has(panelBlock.id)) return
  closingPanels.add(panelBlock.id)
  // Only OUR maximize is ours to undo. `undefined` leaves the flag alone, so a
  // maximize the user set before entering notes survives the close.
  //
  // PEEKED here and consumed only once the close COMMITS: deleting up front
  // spends the marker even when the tx below rejects, and the retry then
  // computes `undefined` — so the second attempt leaves notes while keeping
  // the auto-maximize, hiding every sibling pane with nothing left that owns
  // the flag. Nothing re-adds it either; only a fresh enter does.
  const maximized = maximizedByNotesEnter.has(panelBlock.id) ? false : undefined
  let closed = false
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
      && await goBackInPanel(panelBlock, {maximized})) {
      closed = true
      return
    }
    const current = panelBlock.peekProperty(topLevelBlockIdProp)
    // Not a close — the pane shows nothing, so nothing was written and the
    // marker stays unspent.
    if (!current) return
    // Same-block with an EXPLICIT undefined mode: navigateInPanel's
    // same-block branch is presence-gated, so this is the clear-only tx.
    await navigateInPanel(panelBlock, current, {viewMode: undefined, maximized})
    closed = true
  } finally {
    if (closed) maximizedByNotesEnter.delete(panelBlock.id)
    closingPanels.delete(panelBlock.id)
  }
}
