import { CallbackSet } from "./callbackSet.js";
//#region src/utils/keyboardViewport.ts
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
*  NB: `getLayoutViewportKeyboardOverlap` (below) is the SIBLING quantity for
*  the mobile editing toolbar's `position:fixed` bottom inset — the same
*  arithmetic, but it reads `documentElement.clientHeight` for the
*  layout-viewport height instead of `window.innerHeight`. innerHeight is fine
*  here (fed only as ONE input to a keyboard-up gate — the ≥60 overlap arm,
*  OR-ed with and backstopped by the editing-toolbar sentinel — where its iOS
*  Stage-Manager under-reporting is tolerable) but WRONG for positioning a
*  layout-anchored fixed element, which needs the reliable clientHeight. They
*  stay two readers, not one parameterized helper — the height-source
*  difference is load-bearing. */
var computeOverlap = () => {
	if (typeof window === "undefined") return 0;
	const vv = window.visualViewport;
	if (!vv) return 0;
	return Math.max(0, Math.round(window.innerHeight - (vv.height + vv.offsetTop)));
};
/** Current keyboard overlap, recomputed live. Used only to detect whether a
*  real on-screen keyboard is up (see keyboardAwareScroll's re-assert gate) —
*  NOT as a scroll amount: the keyboard itself is the browser's job. */
var getKeyboardOverlap = () => computeOverlap();
/** Pure: the CSS px of the *layout* viewport hidden below the visible (visual)
*  viewport — i.e. the bottom inset that lifts a layout-anchored
*  `position: fixed; bottom: 0` element (the mobile editing toolbar) to just
*  above the on-screen keyboard. Clamped ≥ 0. Subtracting the visual viewport's
*  offsetTop tracks the iOS pan as the page scrolls with the keyboard up. */
var layoutViewportKeyboardOverlap = (layoutHeight, visualViewportHeight, visualViewportOffsetTop) => Math.max(0, Math.round(layoutHeight - visualViewportHeight - visualViewportOffsetTop));
/** Live {@link layoutViewportKeyboardOverlap} read from the DOM — the mobile
*  editing toolbar's `bottom` inset. Uses `documentElement.clientHeight` (NOT
*  `window.innerHeight`, which under-reports on iOS Stage Manager + scroll) for
*  the layout-viewport height, since a fixed element is positioned against the
*  layout viewport. On Chromium/Firefox (interactive-widget=resizes-content)
*  clientHeight and vv.height shrink together with no pan, so this is ~0 and
*  bottom:0 already clears the keyboard. */
var getLayoutViewportKeyboardOverlap = () => {
	if (typeof document === "undefined") return 0;
	const layoutH = document.documentElement.clientHeight;
	const vv = typeof window === "undefined" ? void 0 : window.visualViewport;
	return layoutViewportKeyboardOverlap(layoutH, vv?.height ?? layoutH, vv?.offsetTop ?? 0);
};
/** The visual viewport's current height in CSS px (0 when unavailable). The
*  geometry signal keyboardAwareScroll compares to tell a keyboard open/close
*  (height changed) apart from a pure scroll (offset moved, height same). */
var getVisualViewportHeight = () => typeof window === "undefined" ? 0 : Math.round(window.visualViewport?.height ?? 0);
var listeners = new CallbackSet("keyboard-viewport");
var attached = false;
var notify = () => listeners.notify();
var attach = () => {
	if (attached || typeof window === "undefined") return;
	attached = true;
	const vv = window.visualViewport;
	vv?.addEventListener("resize", notify);
	vv?.addEventListener("scroll", notify);
	window.addEventListener("resize", notify);
};
var detach = () => {
	if (!attached || typeof window === "undefined") return;
	attached = false;
	const vv = window.visualViewport;
	vv?.removeEventListener("resize", notify);
	vv?.removeEventListener("scroll", notify);
	window.removeEventListener("resize", notify);
};
/** Subscribe to visual-viewport geometry changes (keyboard open/close,
*  URL-bar collapse, rotation) *and* editing-toolbar height changes.
*  Listeners are attached lazily on the first subscription and torn down
*  once the last one leaves, so an app with no active editors carries no
*  global listeners. */
var subscribeKeyboardViewport = (listener) => {
	const off = listeners.add(listener);
	attach();
	return () => {
		off();
		if (listeners.size === 0) detach();
	};
};
var editingToolbarHeight = 0;
/** Height of the mobile editing toolbar currently on screen, in CSS px
*  (0 when none is shown). */
var getEditingToolbarHeight = () => editingToolbarHeight;
/** Publish the editing toolbar's measured height. Notifies viewport
*  subscribers on change so a focused editor can re-assert the caret when
*  the toolbar mounts/resizes after the keyboard is already up. */
var setEditingToolbarHeight = (height) => {
	const next = Math.max(0, Math.round(height));
	if (next === editingToolbarHeight) return;
	editingToolbarHeight = next;
	notify();
};
//#endregion
export { getEditingToolbarHeight, getKeyboardOverlap, getLayoutViewportKeyboardOverlap, getVisualViewportHeight, layoutViewportKeyboardOverlap, setEditingToolbarHeight, subscribeKeyboardViewport };

//# sourceMappingURL=keyboardViewport.js.map