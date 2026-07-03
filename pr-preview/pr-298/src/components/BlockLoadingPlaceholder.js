import { useIsMobile } from "../utils/react.js";
import { BulletDot } from "./renderer/DefaultBlockRenderer.js";
import { c } from "react/compiler-runtime";
import { jsx, jsxs } from "react/jsx-runtime";
//#region src/components/BlockLoadingPlaceholder.tsx
/** Single-line bullet estimate — used when no measured height is
*  available. Matches `LazyBlockComponent`'s ESTIMATED_HEIGHT_PX
*  intentionally; both express "we don't yet know, but blocks are
*  usually one line." */
var DEFAULT_RESERVED_HEIGHT_PX = 32;
/**
* Mirrors the default block flex shape so lazy content slots into the
* same visual frame instead of materializing from an empty gap.
*/
function BlockLoadingPlaceholder(t0) {
	const $ = c(11);
	const { reservedHeight: t1 } = t0;
	const reservedHeight = t1 === void 0 ? DEFAULT_RESERVED_HEIGHT_PX : t1;
	const isMobile = useIsMobile();
	let t2;
	if ($[0] !== reservedHeight) {
		t2 = { minHeight: reservedHeight };
		$[0] = reservedHeight;
		$[1] = t2;
	} else t2 = $[1];
	let t3;
	if ($[2] !== isMobile) {
		t3 = !isMobile && /* @__PURE__ */ jsx("span", { className: "h-6 w-3" });
		$[2] = isMobile;
		$[3] = t3;
	} else t3 = $[3];
	let t4;
	if ($[4] === Symbol.for("react.memo_cache_sentinel")) {
		t4 = /* @__PURE__ */ jsx("span", {
			className: "bullet-link flex items-center justify-center h-6 w-5",
			children: /* @__PURE__ */ jsx(BulletDot, {})
		});
		$[4] = t4;
	} else t4 = $[4];
	let t5;
	if ($[5] !== t3) {
		t5 = /* @__PURE__ */ jsxs("div", {
			className: "block-controls flex items-center",
			children: [t3, t4]
		});
		$[5] = t3;
		$[6] = t5;
	} else t5 = $[6];
	let t6;
	if ($[7] === Symbol.for("react.memo_cache_sentinel")) {
		t6 = /* @__PURE__ */ jsx("div", { className: "block-body flex-grow" });
		$[7] = t6;
	} else t6 = $[7];
	let t7;
	if ($[8] !== t2 || $[9] !== t5) {
		t7 = /* @__PURE__ */ jsxs("div", {
			className: "tm-block relative flex items-start gap-1",
			style: t2,
			"aria-hidden": true,
			children: [t5, t6]
		});
		$[8] = t2;
		$[9] = t5;
		$[10] = t7;
	} else t7 = $[10];
	return t7;
}
//#endregion
export { BlockLoadingPlaceholder };

//# sourceMappingURL=BlockLoadingPlaceholder.js.map