import { surfaceFromContext } from "./surface.js";
import { c } from "react/compiler-runtime";
import { Fragment, jsx } from "react/jsx-runtime";
//#region src/plugins/spatial-navigation/ShellDecorator.tsx
var applyRef = (ref, el) => {
	if (!ref) return;
	if (typeof ref === "function") ref(el);
	else ref.current = el;
};
/**
* Shell-decorator contract for spatial navigation:
*   - tag the shell element with data attributes the walker queries.
*
* What this decorator deliberately does NOT do:
*   - subscribe to per-panel focused props. Reading focused location
*     via usePropertyValue here would attach
*     a hook subscription per block in the panel; every focus change
*     then re-renders every block in the panel. That's the
*     performance pitfall the user hit with the previous plugin.
*     `useShortcutSurfaceActivations` already reads focus reactively
*     via `useInFocus(block.id)` — that hook is per-block by
*     construction, so it doesn't fan out the way subscribing on the
*     panel block does.
*   - own a visual "active" highlight class. Focus is communicated by
*     the browser's native focus on the shell element (the shell has
*     tabIndex=0 and we call .focus() on navigation). CSS targets
*     `:focus-visible` for the highlight.
*
* Tagging is done via a callback ref wrapped around the original
* shellRef. That way the data attributes are set synchronously the
* moment React attaches the element — independently of useEffect
* ordering, which broke top-level blocks (the parent decorator's
* effect saw the ref still null on first commit).
*/
function SpatialNavigationShellDecorator(t0) {
	const $ = c(25);
	const { resolveContext, state, children } = t0;
	let t1;
	if ($[0] !== resolveContext.blockContext) {
		t1 = resolveContext.blockContext ?? {};
		$[0] = resolveContext.blockContext;
		$[1] = t1;
	} else t1 = $[1];
	const blockContext = t1;
	let t2;
	if ($[2] !== blockContext) {
		t2 = surfaceFromContext(blockContext);
		$[2] = blockContext;
		$[3] = t2;
	} else t2 = $[3];
	const surface = t2;
	const panelId = typeof blockContext.panelId === "string" ? blockContext.panelId : void 0;
	const renderScopeId = typeof blockContext.renderScopeId === "string" ? blockContext.renderScopeId : void 0;
	const upstreamRef = state.shellProps.ref;
	let t3;
	if ($[4] !== panelId || $[5] !== renderScopeId || $[6] !== surface || $[7] !== upstreamRef) {
		t3 = (el) => {
			applyRef(upstreamRef, el);
			if (el) {
				el.dataset.blockNavItem = "true";
				el.dataset.blockSurface = surface;
				if (renderScopeId) el.dataset.renderScopeId = renderScopeId;
				else delete el.dataset.renderScopeId;
				if (panelId) el.dataset.panelIdHint = panelId;
				else delete el.dataset.panelIdHint;
			}
		};
		$[4] = panelId;
		$[5] = renderScopeId;
		$[6] = surface;
		$[7] = upstreamRef;
		$[8] = t3;
	} else t3 = $[8];
	const wrappedRef = t3;
	let t4;
	let t5;
	if ($[9] !== state.shellProps) {
		t4 = (event) => {
			state.shellProps.onFocus?.(event);
		};
		t5 = (event_0) => {
			state.shellProps.onPointerDownCapture?.(event_0);
		};
		$[9] = state.shellProps;
		$[10] = t4;
		$[11] = t5;
	} else {
		t4 = $[10];
		t5 = $[11];
	}
	let t6;
	if ($[12] !== state.shellProps || $[13] !== t4 || $[14] !== t5 || $[15] !== wrappedRef) {
		t6 = {
			...state.shellProps,
			ref: wrappedRef,
			onFocus: t4,
			onPointerDownCapture: t5
		};
		$[12] = state.shellProps;
		$[13] = t4;
		$[14] = t5;
		$[15] = wrappedRef;
		$[16] = t6;
	} else t6 = $[16];
	let t7;
	if ($[17] !== state.shortcutSurfaceOptions || $[18] !== t6) {
		t7 = {
			shellProps: t6,
			shortcutSurfaceOptions: state.shortcutSurfaceOptions
		};
		$[17] = state.shortcutSurfaceOptions;
		$[18] = t6;
		$[19] = t7;
	} else t7 = $[19];
	const nextState = t7;
	let t8;
	if ($[20] !== children || $[21] !== nextState) {
		t8 = children(nextState);
		$[20] = children;
		$[21] = nextState;
		$[22] = t8;
	} else t8 = $[22];
	let t9;
	if ($[23] !== t8) {
		t9 = /* @__PURE__ */ jsx(Fragment, { children: t8 });
		$[23] = t8;
		$[24] = t9;
	} else t9 = $[24];
	return t9;
}
//#endregion
export { SpatialNavigationShellDecorator };

//# sourceMappingURL=ShellDecorator.js.map