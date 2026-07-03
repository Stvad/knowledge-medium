import { editorViewFromActiveContexts, useActiveContextsState } from "../shortcuts/ActiveContexts.js";
import { acquireEditModeKeepalive } from "./editModeKeepalive.js";
import { useLayoutEffect, useRef } from "react";
import { c } from "react/compiler-runtime";
//#region src/components/useEditModeYieldKeepalive.ts
/**
* Keep the underlying editor in edit mode while an overlay surface is open
* IF it was opened from edit mode. Opening the overlay moves focus off the
* editor, which would otherwise trip BlockEditor's exit-on-blur and
* deactivate the EDIT_MODE_CM context — leaving the surface unable to list
* or run edit commands (and, with vim normal mode off, no block context at
* all). A 'yield-focus' keepalive holds edit mode without pulling focus
* back from the overlay; on close, focus is handed back to the editor we
* kept alive. Acquired in a layout effect so it lands before the blur's
* deferred rAF decision fires.
*
* On close we refocus only if the sampled editor is STILL the active edit
* context and mounted. A command run from the overlay may have moved focus
* to another block or unmounted this editor; refocusing a stale view would
* steal focus from the command, and focus() on a torn-down view can throw
* (no `destroyed` guard in CM).
*
* Lives next to `acquireEditModeKeepalive`'s React consumers rather than in
* editModeKeepalive.ts itself, which is deliberately env-agnostic and
* node-tested. Shared by the command palette and the shortcut-help overlay
* so the subtle focus-return contract is maintained in exactly one place.
*/
function useEditModeYieldKeepalive(open) {
	const $ = c(6);
	const active = useActiveContextsState();
	const activeRef = useRef(active);
	let t0;
	let t1;
	if ($[0] !== active) {
		t0 = () => {
			activeRef.current = active;
		};
		t1 = [active];
		$[0] = active;
		$[1] = t0;
		$[2] = t1;
	} else {
		t0 = $[1];
		t1 = $[2];
	}
	useLayoutEffect(t0, t1);
	let t2;
	let t3;
	if ($[3] !== open) {
		t2 = () => {
			if (!open) return;
			const editorView = editorViewFromActiveContexts(activeRef.current);
			if (!editorView) return;
			const release = acquireEditModeKeepalive("yield-focus");
			return () => {
				if (editorViewFromActiveContexts(activeRef.current) === editorView && editorView.dom.isConnected) editorView.focus();
				release();
			};
		};
		t3 = [open];
		$[3] = open;
		$[4] = t2;
		$[5] = t3;
	} else {
		t2 = $[4];
		t3 = $[5];
	}
	useLayoutEffect(t2, t3);
}
//#endregion
export { useEditModeYieldKeepalive };

//# sourceMappingURL=useEditModeYieldKeepalive.js.map