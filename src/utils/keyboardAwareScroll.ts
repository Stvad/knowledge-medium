import { EditorView, ViewPlugin, type ViewUpdate } from '@codemirror/view'
import type { Extension } from '@codemirror/state'
import { completionStatus } from '@codemirror/autocomplete'
import {
  getEditingToolbarHeight,
  getKeyboardOverlap,
  getVisualViewportHeight,
  subscribeKeyboardViewport,
} from './keyboardViewport.js'

// Below this many CSS px we treat the overlap as viewport noise (URL-bar
// jitter, sub-pixel rounding) rather than a real on-screen keyboard, and
// don't bother re-asserting the caret. On-screen keyboards are far taller
// than this, so it can't swallow a genuine keyboard.
const MIN_KEYBOARD_OVERLAP = 60

/** Decide whether a viewport notification should re-assert (re-scroll) the
 *  caret. The two guards, in order:
 *
 *  1. The *geometry* must have changed — the keyboard's height
 *     (`visualViewport.height`) or the editing toolbar's height. A pure
 *     *scroll* (the visual viewport's offset moved, its height unchanged) must
 *     NOT re-assert: on iOS, programmatically scrolling the caret into view
 *     itself moves that offset and fires another `scroll`, so re-asserting on
 *     scroll is a self-feeding 60fps loop that drags the block out of view.
 *     Neither the keyboard nor the toolbar height depends on the scroll offset,
 *     so this cleanly separates "keyboard/toolbar appeared or resized"
 *     (re-assert) from "the viewport scrolled" — our own echo, and the user's
 *     deliberate panning, which we shouldn't fight either.
 *  2. There must actually be something to clear — a real keyboard
 *     (overlap ≥ MIN) or a mounted toolbar. The toolbar height is only nonzero
 *     while the toolbar is rendered, so it's a reliable signal even on Chrome
 *     Android's resizes-content path where the keyboard overlap stays 0.
 *     (`keyboardOverlap` is derived from `window.innerHeight`, which iOS can
 *     under-report in Stage Manager + scroll — but the toolbar arm carries the
 *     gate whenever editing on mobile, so a corrupt overlap can't disable it.)
 *
 *  Accepted edge: the keyboard opening always fires a resize (geometry change),
 *  so the caret is lifted; but if the browser's FINAL settle nudge arrives as a
 *  trailing pure `scroll` (height already stable), it's ignored — the preceding
 *  resize already cleared the caret, so this is a deliberate trade, not a miss.
 *  Do NOT "fix" it by re-asserting on scroll: that resurrects the 60fps loop. */
export const shouldReassertCaret = (
  prev: {vvHeight: number; toolbarHeight: number},
  cur: {vvHeight: number; toolbarHeight: number; keyboardOverlap: number},
): boolean => {
  const geometryChanged =
    cur.vvHeight !== prev.vvHeight || cur.toolbarHeight !== prev.toolbarHeight
  if (!geometryChanged) return false
  return cur.keyboardOverlap >= MIN_KEYBOARD_OVERLAP || cur.toolbarHeight > 0
}

/** Keeps the caret clear of the editing chrome that the browser doesn't
 *  know about while editing on a touch device.
 *
 *  Division of labor with the browser:
 *  - The on-screen KEYBOARD is the browser's job. Mobile browsers natively
 *    scroll a focused editable above the keyboard (iOS pans the visual
 *    viewport; Chrome/Android resizes-content shrinks the layout viewport). We
 *    do NOT re-do that. Earlier this extension fed the keyboard *overlap* into
 *    CodeMirror's scrollMargins, but on iOS that overlap is measured against
 *    a full-height layout viewport while the visible region is the panned
 *    visual viewport — and scrolling the document to satisfy it itself moves
 *    the pan, so CM chased a moving target and the block jittered / scrolled
 *    out of view on every keystroke. Letting the browser own the keyboard
 *    avoids that coordinate fight entirely.
 *    CAVEAT: verified on iOS (device) and desktop (inert). On *layout-anchored*
 *    Android browsers (Edge / Samsung Internet) the layout viewport stays full
 *    and the keyboard overlays — if such a browser also does NOT native-scroll
 *    the focused editable, the caret could sit behind the keyboard (the bug
 *    this code originally fixed for those browsers by reserving the overlap).
 *    Unverified there, and not our fleet; if it ever regresses, reintroduce the
 *    overlap margin gated to a RELIABLE "does the visual viewport pan?" probe
 *    (NOT the MobileKeyboardToolbar sentinel, which misdetects on iOS).
 *  - The editing TOOLBAR is OUR job. The mobile keyboard toolbar floats
 *    (`position: fixed`) just above the keyboard, so the browser's native
 *    scroll — which only clears the keyboard — leaves the caret behind it.
 *    Its height is published via `setEditingToolbarHeight` and is a stable,
 *    pan-independent quantity, so reserving it as a CodeMirror bottom scroll
 *    margin nudges the caret clear of the toolbar without the keyboard-overlap
 *    instability.
 *
 *  Two cooperating pieces:
 *  - `scrollMargins` reserves the toolbar height at the bottom of the
 *    editor's scroll target, so CodeMirror's own "scroll the cursor into
 *    view" lands the caret above the toolbar.
 *  - a ViewPlugin re-asserts the caret when the editing toolbar mounts/
 *    resizes (or the keyboard opens) after focus, since those fire after the
 *    focus call. BlockEditor's edit-entry scroll covers the inverse case
 *    (keyboard already up when you tap a second block), which fires no resize.
 *
 *  Inert on desktop and on mobile with no toolbar: the toolbar height is 0,
 *  so the margin is null and the re-assert is gated out. */
export const keyboardAwareScroll = (): Extension => [
  EditorView.scrollMargins.of((view) => {
    // While a completion popup is open, contribute NO bottom inset.
    // CodeMirror positions tooltips against the editor's own scroll rect
    // MINUS these margins; because each block is its own (usually
    // single-line) editor, a bottom inset taller than the block pushes the
    // computed "visible bottom" above the caret, so CM treats the caret as
    // off-screen and parks the popup at top:-10000 — i.e. the autocomplete
    // dropdown silently vanishes whenever the editing toolbar is up. CM
    // reuses scrollMargins AS the tooltip's clip rect, so the inset can't be
    // kept for the popup's sake (tooltipSpace / a body parent don't help —
    // the clip is scrollDOM−margins regardless) and a single-line block can't
    // carry an inset that clears the toolbar without tripping the hide-test.
    // We pick popup visibility. Tradeoff: the inset also feeds the
    // caret-into-view scroll, so it's dropped there too while a completion is
    // open — if you filter deep in a block at the viewport bottom the caret
    // can sit under the toolbar until the popup closes (narrow: edit-entry
    // already lifted the block clear, single-line filtering doesn't move the
    // caret down, and the popup stays visible).
    if (completionStatus(view.state) === 'active') return null
    // Reserve ONLY the editing toolbar's height — the keyboard is the
    // browser's job (see the header). Stable and pan-independent, so CM's
    // caret-into-view lands above the toolbar without the keyboard-overlap
    // jitter. 0 (→ null) on desktop and on mobile with no toolbar.
    const toolbarHeight = getEditingToolbarHeight()
    return toolbarHeight > 0 ? {bottom: toolbarHeight} : null
  }),
  ViewPlugin.fromClass(
    class {
      private unsubscribe: (() => void) | null = null
      // Last viewport *geometry* we re-asserted against — the keyboard's
      // height and the editing toolbar's height. Compared on every
      // notification to tell a geometry change (keyboard/toolbar
      // appeared/resized → re-assert) apart from a pure scroll (the visual
      // viewport's offset moved, its height unchanged → ignore). See subscribe.
      private lastVvHeight = -1
      private lastToolbarHeight = -1

      constructor(view: EditorView) {
        // Only the focused editor needs to react to the keyboard; gating
        // the subscription on focus keeps at most one live listener even
        // when several editors are mounted.
        if (view.hasFocus) this.subscribe(view)
      }

      update(update: ViewUpdate) {
        if (!update.focusChanged) return
        if (update.view.hasFocus) this.subscribe(update.view)
        else this.teardown()
      }

      destroy() {
        this.teardown()
      }

      private subscribe(view: EditorView) {
        if (this.unsubscribe) return
        // Seed the geometry baseline with the *current* values so a stream of
        // pure-scroll notifications (no keyboard/toolbar change) can't trigger
        // a spurious first re-assert.
        this.lastVvHeight = getVisualViewportHeight()
        this.lastToolbarHeight = getEditingToolbarHeight()
        this.unsubscribe = subscribeKeyboardViewport(() => {
          if (!view.hasFocus) return
          const cur = {
            vvHeight: getVisualViewportHeight(),
            toolbarHeight: getEditingToolbarHeight(),
            keyboardOverlap: getKeyboardOverlap(),
          }
          const reassert = shouldReassertCaret(
            {vvHeight: this.lastVvHeight, toolbarHeight: this.lastToolbarHeight},
            cur,
          )
          this.lastVvHeight = cur.vvHeight
          this.lastToolbarHeight = cur.toolbarHeight
          if (!reassert) return
          view.dispatch({
            effects: EditorView.scrollIntoView(view.state.selection.main.head),
          })
        })
      }

      private teardown() {
        this.unsubscribe?.()
        this.unsubscribe = null
      }
    },
  ),
]
