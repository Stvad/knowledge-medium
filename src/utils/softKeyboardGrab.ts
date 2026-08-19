/** Raise the on-screen keyboard from within a user gesture.
 *
 *  iOS WebKit only pops the soft keyboard when an element is focused
 *  *synchronously inside a user gesture*. Entering block edit mode focuses the
 *  CodeMirror editor a frame later: an async state round-trip
 *  (`enterEditModeForBlock`) mounts the editor, then a `requestAnimationFrame`
 *  in BlockEditor's focus effect calls `editorView.focus()`. That focus is
 *  outside the original tap's gesture, so iOS refuses to raise the keyboard —
 *  the block enters edit mode but the keyboard only appears on a *second*,
 *  direct tap on the now-mounted editable. (Device-verified on iPad iOS 26: a
 *  synchronous focus dropped the visual viewport 748→320 within ~110ms; the
 *  deferred one did nothing.)
 *
 *  `grabSoftKeyboard()` bridges the gap. Called synchronously from the tap
 *  handler, it focuses a hidden proxy `<input>`, so the OS raises the keyboard
 *  immediately. When the real editor focuses a frame later, focus simply
 *  transfers between two text-entry elements and the already-up keyboard stays
 *  visible. Focusing an input is a no-op for the keyboard when a hardware
 *  keyboard is attached, so this only ever surfaces a keyboard the user was
 *  about to get anyway.
 *
 *  iOS WebKit ONLY. Android and desktop already raise the keyboard on the
 *  editor's own deferred focus; on Android the extra proxy focus actually makes
 *  the keyboard flash-then-hide, so it must not run there. It DOES run when the
 *  keyboard is already up (switching from one editing block to another): the tap
 *  blurs the old editor and a non-editable `.tm-block` container briefly grabs
 *  focus, which dismisses the keyboard before the new editor focuses ~a frame
 *  later — so the proxy is needed to hold the keyboard across that gap too. */

import { isIOS } from '@/utils/platform.js'

let proxyInput: HTMLInputElement | undefined

/** The single pending failsafe-blur timer. Only ever ONE is outstanding: each
 *  grab cancels the previous before arming its own, so an earlier tap's timer
 *  can't fire mid-handoff of a later tap (which re-focuses the same singleton
 *  proxy) and blur the keyboard the later grab is still holding. */
let failsafeTimer: ReturnType<typeof setTimeout> | undefined

/** How long the proxy holds focus (and the keyboard) before the failsafe blur.
 *  It must comfortably outlast the async edit-entry → editor-focus handoff, or
 *  the failsafe blurs mid-handoff and drops the keyboard the grab just raised.
 *  Device-measured on iPad over a dev tunnel: the editor focuses ~1.1s after the
 *  tap (an `enterEditModeForBlock` DB round-trip → re-render → CM mount → rAF
 *  focus), so this sits well beyond that. On success the editor steals focus
 *  long before the timeout, so the failsafe is a no-op; it only fires when edit
 *  mode never materializes, briefly stranding the keyboard until then. */
const FOCUS_HANDOFF_TIMEOUT_MS = 3000

/** The singleton hidden proxy, created lazily. Zero-opacity + `position: fixed`
 *  so focusing it neither scrolls the page nor shows anything; sized 1px rather
 *  than `display:none` / `visibility:hidden`, which would make it unfocusable. */
const ensureProxy = (): HTMLInputElement => {
  if (proxyInput?.isConnected) return proxyInput
  const el = document.createElement('input')
  el.type = 'text'
  el.tabIndex = -1
  el.setAttribute('aria-hidden', 'true')
  el.setAttribute('autocomplete', 'off')
  el.setAttribute('autocorrect', 'off')
  el.setAttribute('autocapitalize', 'off')
  Object.assign(el.style, {
    position: 'fixed',
    bottom: '0',
    left: '0',
    width: '1px',
    height: '1px',
    opacity: '0',
    border: '0',
    padding: '0',
    margin: '0',
    pointerEvents: 'none',
  })
  document.body.appendChild(el)
  proxyInput = el
  return el
}

/** Synchronously focus the proxy so the OS surfaces the soft keyboard within
 *  the current gesture. Call from a tap/click handler that is about to enter
 *  edit mode; the editor's own (deferred) focus then transfers seamlessly.
 *
 *  Failsafe: if edit mode never materializes — the editor never steals focus —
 *  the proxy would strand the keyboard open, so blur it shortly after if it's
 *  still the active element. In the normal path the editor has taken focus long
 *  before then and the blur is skipped. */
export const grabSoftKeyboard = (): void => {
  if (!isIOS() || typeof document === 'undefined') return
  const el = ensureProxy()
  try {
    el.focus({preventScroll: true})
  } catch {
    return
  }
  // Cancel any prior grab's failsafe first: without this, an earlier tap's
  // timer could fire while this grab's handoff is still in flight (proxy
  // re-focused, editor not yet focused) and blur the keyboard we just raised.
  if (failsafeTimer !== undefined) clearTimeout(failsafeTimer)
  failsafeTimer = setTimeout(() => {
    failsafeTimer = undefined
    if (document.activeElement === el) el.blur()
  }, FOCUS_HANDOFF_TIMEOUT_MS)
}
