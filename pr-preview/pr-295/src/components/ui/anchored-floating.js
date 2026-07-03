import { __exportAll } from "../../../_virtual/_rolldown/runtime.js";
import clamp from "../../../node_modules/lodash-es/clamp.js";
import { autoUpdate, computePosition, flip, offset, shift, size } from "../../../node_modules/@floating-ui/dom/dist/floating-ui.dom.js";
import { useEffect, useLayoutEffect, useState } from "react";
import { c } from "react/compiler-runtime";
//#region src/components/ui/anchored-floating.ts
var anchored_floating_exports = /* @__PURE__ */ __exportAll({
	floatingAnchorFromRect: () => floatingAnchorFromRect,
	useAnchoredFloating: () => useAnchoredFloating
});
var initialFloatingStyle = {
	left: 0,
	position: "fixed",
	top: 0
};
var useIsomorphicLayoutEffect = typeof window === "undefined" ? useEffect : useLayoutEffect;
var floatingAnchorFromRect = (rect) => ({ getBoundingClientRect: () => ({
	bottom: rect.bottom,
	height: rect.height,
	left: rect.left,
	right: rect.right,
	top: rect.top,
	width: rect.width,
	x: rect.left,
	y: rect.top
}) });
var useAnchoredFloating = (t0) => {
	const $ = c(34);
	const { open, anchorElement, anchorRect, placement: t1, gap: t2, viewportMargin: t3, fallbackStyle: t4, sizing } = t0;
	const placement = t1 === void 0 ? "bottom" : t1;
	const gap = t2 === void 0 ? 8 : t2;
	const viewportMargin = t3 === void 0 ? 8 : t3;
	const fallbackStyle = t4 === void 0 ? initialFloatingStyle : t4;
	const [floatingElement, setFloatingElement] = useState(null);
	const [floatingStyle, setFloatingStyle] = useState(initialFloatingStyle);
	const [positioned, setPositioned] = useState(false);
	let t5;
	if ($[0] !== anchorElement || $[1] !== anchorRect) {
		t5 = anchorElement ?? (anchorRect ? floatingAnchorFromRect(anchorRect) : null);
		$[0] = anchorElement;
		$[1] = anchorRect;
		$[2] = t5;
	} else t5 = $[2];
	const anchor = t5;
	let t6;
	if ($[3] !== gap) {
		t6 = offset(gap);
		$[3] = gap;
		$[4] = t6;
	} else t6 = $[4];
	let t7;
	if ($[5] !== viewportMargin) {
		t7 = flip({ padding: viewportMargin });
		$[5] = viewportMargin;
		$[6] = t7;
	} else t7 = $[6];
	let t8;
	if ($[7] !== viewportMargin) {
		t8 = shift({ padding: viewportMargin });
		$[7] = viewportMargin;
		$[8] = t8;
	} else t8 = $[8];
	let t9;
	if ($[9] !== sizing) {
		t9 = (t10) => {
			const { availableWidth, availableHeight, rects, elements } = t10;
			const style = elements.floating.style;
			if (sizing) {
				const { minWidth, maxWidth, minHeight: t11, maxHeight } = sizing;
				const minHeight = t11 === void 0 ? 0 : t11;
				if (minWidth !== void 0 || maxWidth !== void 0) {
					const lower = Math.min(minWidth ?? 0, availableWidth);
					const upper = Math.min(maxWidth ?? availableWidth, availableWidth);
					style.width = `${clamp(rects.reference.width, lower, upper)}px`;
				}
				style.maxHeight = `${Math.max(0, Math.min(maxHeight ?? availableHeight, Math.max(availableHeight, minHeight)))}px`;
			} else style.maxHeight = `${Math.max(0, availableHeight)}px`;
		};
		$[9] = sizing;
		$[10] = t9;
	} else t9 = $[10];
	let t10;
	if ($[11] !== t9 || $[12] !== viewportMargin) {
		t10 = size({
			padding: viewportMargin,
			apply: t9
		});
		$[11] = t9;
		$[12] = viewportMargin;
		$[13] = t10;
	} else t10 = $[13];
	let t11;
	if ($[14] !== t10 || $[15] !== t6 || $[16] !== t7 || $[17] !== t8) {
		t11 = [
			t6,
			t7,
			t8,
			t10
		];
		$[14] = t10;
		$[15] = t6;
		$[16] = t7;
		$[17] = t8;
		$[18] = t11;
	} else t11 = $[18];
	const middleware = t11;
	let t12;
	let t13;
	if ($[19] !== anchor || $[20] !== floatingElement || $[21] !== middleware || $[22] !== open || $[23] !== placement) {
		t12 = () => {
			if (!open || !anchor || !floatingElement) {
				setPositioned(false);
				return;
			}
			let cancelled = false;
			setPositioned(false);
			const update = () => {
				computePosition(anchor, floatingElement, {
					middleware,
					placement,
					strategy: "fixed"
				}).then((t14) => {
					const { x, y } = t14;
					if (cancelled) return;
					setFloatingStyle({
						left: x,
						position: "fixed",
						top: y
					});
					setPositioned(true);
				});
			};
			const cleanup = autoUpdate(anchor, floatingElement, update);
			return () => {
				cancelled = true;
				cleanup();
				floatingElement.style.maxHeight = "";
				floatingElement.style.width = "";
			};
		};
		t13 = [
			anchor,
			floatingElement,
			middleware,
			open,
			placement
		];
		$[19] = anchor;
		$[20] = floatingElement;
		$[21] = middleware;
		$[22] = open;
		$[23] = placement;
		$[24] = t12;
		$[25] = t13;
	} else {
		t12 = $[24];
		t13 = $[25];
	}
	useIsomorphicLayoutEffect(t12, t13);
	let t14;
	if ($[26] !== anchor || $[27] !== fallbackStyle || $[28] !== floatingStyle || $[29] !== open || $[30] !== positioned) {
		t14 = open && anchor ? {
			...floatingStyle,
			...positioned ? {} : { visibility: "hidden" }
		} : fallbackStyle;
		$[26] = anchor;
		$[27] = fallbackStyle;
		$[28] = floatingStyle;
		$[29] = open;
		$[30] = positioned;
		$[31] = t14;
	} else t14 = $[31];
	const resolvedStyle = t14;
	let t15;
	if ($[32] !== resolvedStyle) {
		t15 = {
			floatingStyle: resolvedStyle,
			setFloatingElement
		};
		$[32] = resolvedStyle;
		$[33] = t15;
	} else t15 = $[33];
	return t15;
};
//#endregion
export { anchored_floating_exports, floatingAnchorFromRect, useAnchoredFloating };

//# sourceMappingURL=anchored-floating.js.map