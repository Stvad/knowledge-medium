/** Tracks how much of the layout viewport's bottom edge is currently
 *  hidden behind the on-screen keyboard, in CSS px.
 *
 *  Measured in *layout* coordinates — the space that in-flow / scrolled
 *  content (the panel scroller, a CodeMirror editor) lives in — via
 *  `innerHeight - (visualViewport.height + offsetTop)`. That delta is the
 *  keyboard's intrusion into the layout viewport and is invariant to the
 *  URL bar (which moves both terms together, so it cancels):
 *
 *  - iOS Safari / Edge / Samsung Internet: the layout viewport stays full
 *    height while the visual viewport shrinks → overlap == keyboard
 *    height. The content's bottom rows sit behind the keyboard, so this
 *    is exactly the margin to keep clear.
 *  - Chrome on Android (resizes-content default): the layout viewport
 *    itself shrinks with the keyboard → overlap == 0. The scroller
 *    already shrank, so no extra margin is needed.
 *
 *  NB: this is deliberately a *different* quantity from the mobile
 *  toolbar's `useKeyboardInset`. That one answers "where do I pin a
 *  position:fixed element?", which depends on how the browser anchors
 *  fixed elements (and needs a sentinel probe to detect). For scroll
 *  margins on layout-positioned content the formula above is uniform
 *  across browsers, so the two can't share an implementation. */

import { CallbackSet } from './callbackSet'

const computeOverlap = (): number => {
  if (typeof window === 'undefined') return 0
  const vv = window.visualViewport
  if (!vv) return 0
  return Math.max(0, Math.round(window.innerHeight - (vv.height + vv.offsetTop)))
}

/** Current keyboard overlap, recomputed live. Used only to detect whether a
 *  real on-screen keyboard is up (see keyboardAwareScroll's re-assert gate) —
 *  NOT as a scroll amount: the keyboard itself is the browser's job. */
export const getKeyboardOverlap = (): number => computeOverlap()

/** The visual viewport's current height in CSS px (0 when unavailable). The
 *  geometry signal keyboardAwareScroll compares to tell a keyboard open/close
 *  (height changed) apart from a pure scroll (offset moved, height same). */
export const getVisualViewportHeight = (): number =>
  typeof window === 'undefined' ? 0 : Math.round(window.visualViewport?.height ?? 0)

const listeners = new CallbackSet('keyboard-viewport')
let attached = false

const notify = (): void => listeners.notify()

const attach = () => {
  if (attached || typeof window === 'undefined') return
  attached = true
  const vv = window.visualViewport
  vv?.addEventListener('resize', notify)
  vv?.addEventListener('scroll', notify)
  window.addEventListener('resize', notify)
}

const detach = () => {
  if (!attached || typeof window === 'undefined') return
  attached = false
  const vv = window.visualViewport
  vv?.removeEventListener('resize', notify)
  vv?.removeEventListener('scroll', notify)
  window.removeEventListener('resize', notify)
}

/** Subscribe to visual-viewport geometry changes (keyboard open/close,
 *  URL-bar collapse, rotation) *and* editing-toolbar height changes.
 *  Listeners are attached lazily on the first subscription and torn down
 *  once the last one leaves, so an app with no active editors carries no
 *  global listeners. */
export const subscribeKeyboardViewport = (listener: () => void): (() => void) => {
  const off = listeners.add(listener)
  attach()
  return () => {
    off()
    if (listeners.size === 0) detach()
  }
}

// The mobile editing toolbar floats just above the keyboard while a block
// is being edited, so it obscures another strip of the otherwise-visible
// area. The toolbar publishes its measured height here (0 when it isn't
// shown) so scroll math can keep the caret above it too, not just above
// the keyboard.
let editingToolbarHeight = 0

/** Height of the mobile editing toolbar currently on screen, in CSS px
 *  (0 when none is shown). */
export const getEditingToolbarHeight = (): number => editingToolbarHeight

/** Publish the editing toolbar's measured height. Notifies viewport
 *  subscribers on change so a focused editor can re-assert the caret when
 *  the toolbar mounts/resizes after the keyboard is already up. */
export const setEditingToolbarHeight = (height: number): void => {
  const next = Math.max(0, Math.round(height))
  if (next === editingToolbarHeight) return
  editingToolbarHeight = next
  notify()
}
