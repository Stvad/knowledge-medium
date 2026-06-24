import { EditorView, ViewPlugin, type ViewUpdate } from '@codemirror/view'
import type { Extension } from '@codemirror/state'
import {
  getBottomEditingInset,
  getEditingToolbarHeight,
  getKeyboardOverlap,
  subscribeKeyboardViewport,
} from './keyboardViewport.js'

// Below this many CSS px we treat the overlap as viewport noise (URL-bar
// jitter, sub-pixel rounding) rather than a real on-screen keyboard, and
// don't bother re-asserting the caret. On-screen keyboards are far taller
// than this, so it can't swallow a genuine keyboard.
const MIN_KEYBOARD_OVERLAP = 60

/** Keeps the caret visible above the on-screen keyboard while editing.
 *
 *  Two cooperating pieces:
 *  - `scrollMargins` reserves the bottom editing inset (keyboard height
 *    plus the editing toolbar floating above it) at the bottom of the
 *    editor's scroll target, so CodeMirror's own "scroll the cursor into
 *    view" (on edit-entry and as the user types near the bottom) lands
 *    the caret above that chrome instead of behind it. CodeMirror measures
 *    the scroller in layout coordinates, which is exactly what
 *    `getBottomEditingInset` reports.
 *  - a ViewPlugin re-asserts the caret when the keyboard *opens after*
 *    focus. Tapping a block focuses it, but the keyboard then animates up
 *    a few frames later — a visualViewport resize that the focus call
 *    can't wait for. The same subscription also fires when the editing
 *    toolbar mounts/resizes, so a late-arriving toolbar still lifts the
 *    caret clear. BlockEditor's edit-entry scroll covers the inverse case
 *    (keyboard already up when you tap a second block), which fires no
 *    resize.
 *
 *  Inert on desktop: with no keyboard the inset is 0, so the margin is
 *  null and the re-assert is gated out. */
export const keyboardAwareScroll = (): Extension => [
  EditorView.scrollMargins.of(() => {
    const inset = getBottomEditingInset()
    return inset > 0 ? {bottom: inset} : null
  }),
  ViewPlugin.fromClass(
    class {
      private unsubscribe: (() => void) | null = null

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
        this.unsubscribe = subscribeKeyboardViewport(() => {
          if (!view.hasFocus) return
          // Re-scroll when there's a real keyboard OR the editing toolbar
          // is present. The toolbar height is only ever nonzero while the
          // toolbar is actually rendered (mobile + editing), so it's a
          // reliable signal rather than viewport noise. This matters on
          // Chrome Android's resizes-content path, where the keyboard
          // overlap stays 0 (the layout viewport shrank with the keyboard)
          // yet the toolbar still obscures the caret.
          if (getKeyboardOverlap() < MIN_KEYBOARD_OVERLAP && getEditingToolbarHeight() === 0) {
            return
          }
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
