import { useInEditMode, useInFocus, useIsActivePanel, useUIStateBlock } from "../data/globalState.js";
import { isElementProperlyVisible } from "../utils/dom.js";
import { useEffect, useLayoutEffect } from "react";
import { c } from "react/compiler-runtime";
import { Fragment as Fragment$1, jsx } from "react/jsx-runtime";
//#region src/extensions/BlockFocusShellDecorator.tsx
var FOCUSED_BLOCK_CLASS = "[&>.block-body>div:first-child]:bg-accent/40";
var mergeClassName = (...parts) => {
	const className = parts.filter(Boolean).join(" ");
	return className.length ? className : void 0;
};
var isSurfaceActive = (state) => typeof state.shortcutSurfaceOptions.surfaceActive === "boolean" ? state.shortcutSurfaceOptions.surfaceActive : true;
function BlockFocusShellDecorator(t0) {
	const $ = c(27);
	const { resolveContext, shellRef, contentRef, state, children } = t0;
	const { block } = resolveContext;
	const blockInFocus = useInFocus(block.id);
	const inEditMode = useInEditMode(block.id);
	const panelActive = useIsActivePanel(useUIStateBlock());
	let t1;
	if ($[0] !== blockInFocus || $[1] !== panelActive || $[2] !== state) {
		t1 = blockInFocus && isSurfaceActive(state) && panelActive;
		$[0] = blockInFocus;
		$[1] = panelActive;
		$[2] = state;
		$[3] = t1;
	} else t1 = $[3];
	const active = t1;
	let t2;
	let t3;
	if ($[4] !== active || $[5] !== inEditMode || $[6] !== shellRef) {
		t2 = () => {
			if (!active || inEditMode) return;
			const element = shellRef.current;
			if (!element) return;
			const activeElement = document.activeElement;
			if (activeElement === element || element.contains(activeElement)) return;
			if (activeElement && activeElement !== document.body) return;
			element.focus({ preventScroll: true });
		};
		t3 = [
			active,
			inEditMode,
			shellRef
		];
		$[4] = active;
		$[5] = inEditMode;
		$[6] = shellRef;
		$[7] = t2;
		$[8] = t3;
	} else {
		t2 = $[7];
		t3 = $[8];
	}
	useLayoutEffect(t2, t3);
	let t4;
	let t5;
	if ($[9] !== active || $[10] !== contentRef) {
		t4 = () => {
			if (!active) return;
			const element_0 = contentRef.current;
			if (element_0 && !isElementProperlyVisible(element_0)) element_0.scrollIntoView({
				behavior: "smooth",
				block: "nearest"
			});
		};
		t5 = [active, contentRef];
		$[9] = active;
		$[10] = contentRef;
		$[11] = t4;
		$[12] = t5;
	} else {
		t4 = $[11];
		t5 = $[12];
	}
	useEffect(t4, t5);
	const t6 = state.shellProps;
	const t7 = active ? FOCUSED_BLOCK_CLASS : void 0;
	let t8;
	if ($[13] !== state.shellProps.className || $[14] !== t7) {
		t8 = mergeClassName(state.shellProps.className, t7);
		$[13] = state.shellProps.className;
		$[14] = t7;
		$[15] = t8;
	} else t8 = $[15];
	let t9;
	if ($[16] !== state.shellProps || $[17] !== t8) {
		t9 = {
			...t6,
			className: t8
		};
		$[16] = state.shellProps;
		$[17] = t8;
		$[18] = t9;
	} else t9 = $[18];
	let t10;
	if ($[19] !== state.shortcutSurfaceOptions || $[20] !== t9) {
		t10 = {
			shellProps: t9,
			shortcutSurfaceOptions: state.shortcutSurfaceOptions
		};
		$[19] = state.shortcutSurfaceOptions;
		$[20] = t9;
		$[21] = t10;
	} else t10 = $[21];
	const nextState = t10;
	let t11;
	if ($[22] !== children || $[23] !== nextState) {
		t11 = children(nextState);
		$[22] = children;
		$[23] = nextState;
		$[24] = t11;
	} else t11 = $[24];
	let t12;
	if ($[25] !== t11) {
		t12 = /* @__PURE__ */ jsx(Fragment$1, { children: t11 });
		$[25] = t11;
		$[26] = t12;
	} else t12 = $[26];
	return t12;
}
var blockFocusShellDecorator = () => BlockFocusShellDecorator;
//#endregion
export { BlockFocusShellDecorator, blockFocusShellDecorator };

//# sourceMappingURL=BlockFocusShellDecorator.js.map