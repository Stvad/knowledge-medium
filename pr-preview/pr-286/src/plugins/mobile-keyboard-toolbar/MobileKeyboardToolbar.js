import { ActionContextTypes } from "../../shortcuts/types.js";
import { editorViewFromActiveContexts, useActiveContextsState } from "../../shortcuts/ActiveContexts.js";
import { getLayoutViewportKeyboardOverlap, setEditingToolbarHeight, subscribeKeyboardViewport } from "../../utils/keyboardViewport.js";
import { withEditModeKeepalive } from "../../components/editModeKeepalive.js";
import { usePointerCoarse } from "../../utils/react.js";
import { useRunAction } from "../../shortcuts/runAction.js";
import { useActionRefItems } from "../../shortcuts/actionRefItems.js";
import { mobileKeyboardToolbarItemsFacet } from "./facet.js";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { c } from "react/compiler-runtime";
import { jsx } from "react/jsx-runtime";
//#region src/plugins/mobile-keyboard-toolbar/MobileKeyboardToolbar.tsx
/** Track a value derived from viewport geometry, recomputed on every relevant
*  change via the shared keyboard-viewport subscription (the same listener set
*  keyboardAwareScroll uses), and re-rendering only when the mapped value
*  changes. `read` must be a stable module-level reader. Only subscribes while
*  `active`, so an app with no active editor carries no listeners.
*
*  Accepted transient: during a rapid keyboard open/close iOS emits a burst of
*  events while clientHeight / vv.height / offsetTop settle independently, so a
*  derived value can be briefly off for a frame; the next event recomputes it.
*  Not rAF-coalesced — that would add a frame of latency to the common
*  smooth-scroll case for a rare, self-correcting blip. */
var useKeyboardViewportValue = (active, read, initial) => {
	const $ = c(4);
	const [value, setValue] = useState(initial);
	let t0;
	let t1;
	if ($[0] !== active || $[1] !== read) {
		t0 = () => {
			if (!active || typeof window === "undefined") return;
			const update = () => setValue((prev) => {
				const next = read();
				return prev === next ? prev : next;
			});
			update();
			return subscribeKeyboardViewport(update);
		};
		t1 = [active, read];
		$[0] = active;
		$[1] = read;
		$[2] = t0;
		$[3] = t1;
	} else {
		t0 = $[2];
		t1 = $[3];
	}
	useEffect(t0, t1);
	return value;
};
/** The toolbar's `bottom` inset — the live layout-viewport keyboard overlap
*  that lifts the `position: fixed` toolbar just above the on-screen keyboard
*  (see `getLayoutViewportKeyboardOverlap` for the iOS clientHeight/pan
*  rationale). ~0 on Chromium/Firefox, nonzero on iOS Safari. */
var useKeyboardInset = (active) => {
	return useKeyboardViewportValue(active, getLayoutViewportKeyboardOverlap, 0);
};
/** Mobile-only toolbar that sits above the on-screen keyboard while a
*  block is being edited. Its buttons are facet contributions
*  (`mobileKeyboardToolbarItemsFacet`): the structural/reference set comes
*  from this plugin, and other plugins add their own (the image button from
*  attachments, the todo toggle from todo). Each button dispatches the same
*  action id that the keyboard binding invokes, so behavior stays in lockstep
*  with the desktop shortcuts. */
function MobileKeyboardToolbar() {
	const $ = c(18);
	const activeContexts = useActiveContextsState();
	let t0;
	if ($[0] !== activeContexts) {
		t0 = activeContexts.has(ActionContextTypes.EDIT_MODE_CM);
		$[0] = activeContexts;
		$[1] = t0;
	} else t0 = $[1];
	const isEditing = t0;
	const runAction = useRunAction();
	const resolved = useActionRefItems(mobileKeyboardToolbarItemsFacet, ActionContextTypes.EDIT_MODE_CM);
	const pointerCoarse = usePointerCoarse();
	const showToolbar = isEditing && pointerCoarse;
	const keyboardInset = useKeyboardInset(showToolbar);
	const toolbarRef = useRef(null);
	let t1;
	if ($[2] === Symbol.for("react.memo_cache_sentinel")) {
		t1 = () => {
			const el = toolbarRef.current;
			if (!el) {
				setEditingToolbarHeight(0);
				return;
			}
			const measure = () => setEditingToolbarHeight(el.getBoundingClientRect().height);
			measure();
			const observer = new ResizeObserver(measure);
			observer.observe(el);
			return () => {
				observer.disconnect();
				setEditingToolbarHeight(0);
			};
		};
		$[2] = t1;
	} else t1 = $[2];
	let t2;
	if ($[3] !== showToolbar) {
		t2 = [showToolbar];
		$[3] = showToolbar;
		$[4] = t2;
	} else t2 = $[4];
	useLayoutEffect(t1, t2);
	if (!showToolbar) return null;
	const handleMouseDown = _temp;
	let t3;
	if ($[5] !== activeContexts || $[6] !== runAction) {
		t3 = (actionId) => async (event_0) => {
			event_0.preventDefault();
			event_0.stopPropagation();
			const editorView = editorViewFromActiveContexts(activeContexts);
			const trigger = new CustomEvent("mobile-toolbar-action", { detail: { actionId } });
			const run = async () => {
				try {
					await runAction(actionId, trigger);
				} catch (t4) {
					const error = t4;
					console.error(`[MobileKeyboardToolbar] Failed to run ${actionId}`, error);
				}
			};
			if (actionId === "exit_edit_mode_cm") {
				await run();
				return;
			}
			await withEditModeKeepalive("refocus", run);
			requestAnimationFrame(() => editorView?.focus());
		};
		$[5] = activeContexts;
		$[6] = runAction;
		$[7] = t3;
	} else t3 = $[7];
	const handleClick = t3;
	let t4;
	if ($[8] !== keyboardInset) {
		t4 = { bottom: keyboardInset };
		$[8] = keyboardInset;
		$[9] = t4;
	} else t4 = $[9];
	let t5;
	if ($[10] !== handleClick || $[11] !== resolved) {
		let t6;
		if ($[13] !== handleClick) {
			t6 = (t7) => {
				const { item, action } = t7;
				if (!action?.icon) return null;
				const Icon = action.icon;
				return /* @__PURE__ */ jsx("button", {
					type: "button",
					"aria-label": action.description,
					title: action.description,
					onMouseDown: handleMouseDown,
					onClick: handleClick(item.actionId),
					className: "flex h-10 min-w-0 flex-1 items-center justify-center rounded-md text-muted-foreground transition-colors active:bg-accent active:text-accent-foreground",
					children: /* @__PURE__ */ jsx(Icon, { className: "h-5 w-5" })
				}, item.id);
			};
			$[13] = handleClick;
			$[14] = t6;
		} else t6 = $[14];
		t5 = resolved.map(t6);
		$[10] = handleClick;
		$[11] = resolved;
		$[12] = t5;
	} else t5 = $[12];
	let t6;
	if ($[15] !== t4 || $[16] !== t5) {
		t6 = /* @__PURE__ */ jsx("div", {
			ref: toolbarRef,
			className: "mobile-keyboard-toolbar fixed left-0 right-0 z-50 flex items-center justify-around gap-1 border-t border-border bg-background/95 px-1 py-1 backdrop-blur supports-[backdrop-filter]:bg-background/80",
			style: t4,
			"data-block-interaction": "ignore",
			children: t5
		});
		$[15] = t4;
		$[16] = t5;
		$[17] = t6;
	} else t6 = $[17];
	return t6;
}
function _temp(event) {
	event.preventDefault();
}
//#endregion
export { MobileKeyboardToolbar };

//# sourceMappingURL=MobileKeyboardToolbar.js.map