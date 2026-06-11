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

const computeOverlap = (): number => {
  if (typeof window === 'undefined') return 0
  const vv = window.visualViewport
  if (!vv) return 0
  return Math.max(0, Math.round(window.innerHeight - (vv.height + vv.offsetTop)))
}

/** Current keyboard overlap, recomputed live. Cheap enough to read from a
 *  CodeMirror scrollMargins facet on every scroll computation. */
export const getKeyboardOverlap = (): number => computeOverlap()

type Listener = () => void

const listeners = new Set<Listener>()
let attached = false

const notify = () => {
  for (const listener of listeners) listener()
}

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
 *  URL-bar collapse, rotation). Listeners are attached lazily on the
 *  first subscription and torn down once the last one leaves, so an app
 *  with no active editors carries no global listeners. */
export const subscribeKeyboardViewport = (listener: Listener): (() => void) => {
  listeners.add(listener)
  attach()
  return () => {
    listeners.delete(listener)
    if (listeners.size === 0) detach()
  }
}
