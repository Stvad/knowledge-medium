import { actionContextsFacet } from "../extensions/core.js";
import { useAppRuntime } from "../extensions/runtimeContext.js";
import { ActionContextTypes } from "./types.js";
import { createContext, useContext, useLayoutEffect, useRef, useState } from "react";
import { c } from "react/compiler-runtime";
import { jsx } from "react/jsx-runtime";
//#region src/shortcuts/ActiveContexts.tsx
/** The live CodeMirror editor view from the active EDIT_MODE_CM context, or
*  undefined when nothing is in edit mode. Centralizes the EDIT_MODE_CM-deps
*  cast shared by the command palette and the mobile keyboard toolbar (the map
*  values are the generic `BaseShortcutDependencies`, so each reader otherwise
*  hand-rolls the same narrowing). */
var editorViewFromActiveContexts = (contexts) => contexts.get(ActionContextTypes.EDIT_MODE_CM)?.editorView;
/**
* Split into two contexts so that consumers of the *dispatch* (most blocks, via
* `useActionContextActivations`) don't re-render when the active-contexts map
* changes. Only the few consumers that need to read the map subscribe to the
* state context.
*/
var ActiveContextsStateCtx = createContext(null);
var ActiveContextsDispatchCtx = createContext(null);
var shallowEqualDependencies = (a, b) => {
	if (!a) return false;
	if (Object.is(a, b)) return true;
	const aRecord = a;
	const bRecord = b;
	const aKeys = Object.keys(aRecord);
	const bKeys = Object.keys(bRecord);
	if (aKeys.length !== bKeys.length) return false;
	for (const key of aKeys) if (!Object.is(aRecord[key], bRecord[key])) return false;
	return true;
};
function ActiveContextsProvider(t0) {
	const $ = c(9);
	const { children } = t0;
	const runtime = useAppRuntime();
	const runtimeRef = useRef(runtime);
	let t1;
	let t2;
	if ($[0] !== runtime) {
		t1 = () => {
			runtimeRef.current = runtime;
		};
		t2 = [runtime];
		$[0] = runtime;
		$[1] = t1;
		$[2] = t2;
	} else {
		t1 = $[1];
		t2 = $[2];
	}
	useLayoutEffect(t1, t2);
	const [active, setActive] = useState(_temp);
	let t3;
	if ($[3] === Symbol.for("react.memo_cache_sentinel")) {
		t3 = (context, dependencies) => {
			const config = runtimeRef.current.read(actionContextsFacet).find((c) => c.type === context);
			if (!config) throw new Error(`[ActiveContexts] Attempted to activate unregistered context: ${context}`);
			if (!config.validateDependencies(dependencies)) throw new Error(`[ActiveContexts] Invalid dependencies provided for context ${context}. Activation failed.`);
			setActive((prev) => {
				const current = prev.get(context);
				if (Array.from(prev.keys()).at(-1) === context && shallowEqualDependencies(current, dependencies)) return prev;
				const next = new Map(prev);
				next.delete(context);
				next.set(context, dependencies);
				return next;
			});
		};
		$[3] = t3;
	} else t3 = $[3];
	const activate = t3;
	let t4;
	if ($[4] === Symbol.for("react.memo_cache_sentinel")) {
		t4 = (context_0) => {
			setActive((prev_0) => {
				if (!prev_0.has(context_0)) return prev_0;
				const next_0 = new Map(prev_0);
				next_0.delete(context_0);
				return next_0;
			});
		};
		$[4] = t4;
	} else t4 = $[4];
	const deactivate = t4;
	let t5;
	if ($[5] === Symbol.for("react.memo_cache_sentinel")) {
		t5 = {
			activate,
			deactivate
		};
		$[5] = t5;
	} else t5 = $[5];
	const dispatch = t5;
	let t6;
	if ($[6] !== active || $[7] !== children) {
		t6 = /* @__PURE__ */ jsx(ActiveContextsDispatchCtx.Provider, {
			value: dispatch,
			children: /* @__PURE__ */ jsx(ActiveContextsStateCtx.Provider, {
				value: active,
				children
			})
		});
		$[6] = active;
		$[7] = children;
		$[8] = t6;
	} else t6 = $[8];
	return t6;
}
/**
* Read the map of currently-active contexts. Consumers of this hook re-render
* on every activation change — use sparingly (HotkeyReconciler, useRunAction).
*/
function _temp() {
	return /* @__PURE__ */ new Map();
}
function useActiveContextsState() {
	const state = useContext(ActiveContextsStateCtx);
	if (state === null) throw new Error("useActiveContextsState must be used within an ActiveContextsProvider");
	return state;
}
/**
* Access the stable {activate, deactivate} callbacks. Consumers of this hook
* do NOT re-render on activation changes, which is the common case for block
* components that only register/unregister their shortcut surfaces.
*/
function useActiveContextsDispatch() {
	const dispatch = useContext(ActiveContextsDispatchCtx);
	if (!dispatch) throw new Error("useActiveContextsDispatch must be used within an ActiveContextsProvider");
	return dispatch;
}
//#endregion
export { ActiveContextsProvider, editorViewFromActiveContexts, useActiveContextsDispatch, useActiveContextsState };

//# sourceMappingURL=ActiveContexts.js.map