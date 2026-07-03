import { EditorView, ViewPlugin } from "../../node_modules/@codemirror/view/dist/index.js";
import { completionStatus } from "../../node_modules/@codemirror/autocomplete/dist/index.js";
import { getEditingToolbarHeight, getKeyboardOverlap, getVisualViewportHeight, subscribeKeyboardViewport } from "./keyboardViewport.js";
//#region src/utils/keyboardAwareScroll.ts
var MIN_KEYBOARD_OVERLAP = 60;
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
var shouldReassertCaret = (prev, cur) => {
	if (!(cur.vvHeight !== prev.vvHeight || cur.toolbarHeight !== prev.toolbarHeight)) return false;
	return cur.keyboardOverlap >= MIN_KEYBOARD_OVERLAP || cur.toolbarHeight > 0;
};
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
var keyboardAwareScroll = () => [EditorView.scrollMargins.of((view) => {
	if (completionStatus(view.state) === "active") return null;
	const toolbarHeight = getEditingToolbarHeight();
	return toolbarHeight > 0 ? { bottom: toolbarHeight } : null;
}), ViewPlugin.fromClass(class {
	unsubscribe = null;
	lastVvHeight = -1;
	lastToolbarHeight = -1;
	constructor(view) {
		if (view.hasFocus) this.subscribe(view);
	}
	update(update) {
		if (!update.focusChanged) return;
		if (update.view.hasFocus) this.subscribe(update.view);
		else this.teardown();
	}
	destroy() {
		this.teardown();
	}
	subscribe(view) {
		if (this.unsubscribe) return;
		this.lastVvHeight = getVisualViewportHeight();
		this.lastToolbarHeight = getEditingToolbarHeight();
		this.unsubscribe = subscribeKeyboardViewport(() => {
			if (!view.hasFocus) return;
			const cur = {
				vvHeight: getVisualViewportHeight(),
				toolbarHeight: getEditingToolbarHeight(),
				keyboardOverlap: getKeyboardOverlap()
			};
			const reassert = shouldReassertCaret({
				vvHeight: this.lastVvHeight,
				toolbarHeight: this.lastToolbarHeight
			}, cur);
			this.lastVvHeight = cur.vvHeight;
			this.lastToolbarHeight = cur.toolbarHeight;
			if (!reassert) return;
			view.dispatch({ effects: EditorView.scrollIntoView(view.state.selection.main.head) });
		});
	}
	teardown() {
		this.unsubscribe?.();
		this.unsubscribe = null;
	}
})];
//#endregion
export { keyboardAwareScroll, shouldReassertCaret };

//# sourceMappingURL=keyboardAwareScroll.js.map