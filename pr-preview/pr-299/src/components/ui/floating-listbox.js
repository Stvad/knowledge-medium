import { __exportAll } from "../../../_virtual/_rolldown/runtime.js";
import { cn } from "../../lib/utils.js";
import { useAnchoredFloating } from "./anchored-floating.js";
import { createPortal } from "react-dom";
import { c } from "react/compiler-runtime";
import { jsx } from "react/jsx-runtime";
//#region src/components/ui/floating-listbox.tsx
var floating_listbox_exports = /* @__PURE__ */ __exportAll({ FloatingListbox: () => FloatingListbox });
var DEFAULT_MIN_WIDTH = 256;
var DEFAULT_MAX_WIDTH = 448;
var DEFAULT_MIN_HEIGHT = 96;
var DEFAULT_MAX_HEIGHT = 224;
var DEFAULT_VIEWPORT_MARGIN = 8;
var DEFAULT_GAP = 4;
/** An anchored, viewport-clamped popover list (autocomplete/picker
*  dropdowns). Positioning is delegated to {@link useAnchoredFloating} so
*  Floating UI's `autoUpdate` keeps it glued to the anchor when the anchor
*  resizes or content above it reflows — cases the previous window-only
*  tracker missed. */
function FloatingListbox(t0) {
	const $ = c(20);
	const { open, anchorElement, id, role: t1, className, children, minWidth: t2, maxWidth: t3, minHeight: t4, maxHeight: t5, viewportMargin: t6, gap: t7 } = t0;
	const role = t1 === void 0 ? "listbox" : t1;
	const minWidth = t2 === void 0 ? DEFAULT_MIN_WIDTH : t2;
	const maxWidth = t3 === void 0 ? DEFAULT_MAX_WIDTH : t3;
	const minHeight = t4 === void 0 ? DEFAULT_MIN_HEIGHT : t4;
	const maxHeight = t5 === void 0 ? DEFAULT_MAX_HEIGHT : t5;
	const viewportMargin = t6 === void 0 ? DEFAULT_VIEWPORT_MARGIN : t6;
	const gap = t7 === void 0 ? DEFAULT_GAP : t7;
	let t8;
	if ($[0] !== maxHeight || $[1] !== maxWidth || $[2] !== minHeight || $[3] !== minWidth) {
		t8 = {
			minWidth,
			maxWidth,
			minHeight,
			maxHeight
		};
		$[0] = maxHeight;
		$[1] = maxWidth;
		$[2] = minHeight;
		$[3] = minWidth;
		$[4] = t8;
	} else t8 = $[4];
	const sizing = t8;
	let t9;
	if ($[5] !== anchorElement || $[6] !== gap || $[7] !== open || $[8] !== sizing || $[9] !== viewportMargin) {
		t9 = {
			open,
			anchorElement,
			gap,
			viewportMargin,
			sizing
		};
		$[5] = anchorElement;
		$[6] = gap;
		$[7] = open;
		$[8] = sizing;
		$[9] = viewportMargin;
		$[10] = t9;
	} else t9 = $[10];
	const { floatingStyle, setFloatingElement } = useAnchoredFloating(t9);
	if (!open || !anchorElement || typeof document === "undefined") return null;
	let t10;
	if ($[11] !== className) {
		t10 = cn("pointer-events-auto fixed z-[1000] overflow-auto rounded-md border border-border bg-popover p-1 text-sm shadow-lg", className);
		$[11] = className;
		$[12] = t10;
	} else t10 = $[12];
	let t11;
	if ($[13] !== children || $[14] !== floatingStyle || $[15] !== id || $[16] !== role || $[17] !== setFloatingElement || $[18] !== t10) {
		t11 = createPortal(/* @__PURE__ */ jsx("div", {
			id,
			role,
			ref: setFloatingElement,
			className: t10,
			style: floatingStyle,
			children
		}), document.body);
		$[13] = children;
		$[14] = floatingStyle;
		$[15] = id;
		$[16] = role;
		$[17] = setFloatingElement;
		$[18] = t10;
		$[19] = t11;
	} else t11 = $[19];
	return t11;
}
//#endregion
export { FloatingListbox, floating_listbox_exports };

//# sourceMappingURL=floating-listbox.js.map