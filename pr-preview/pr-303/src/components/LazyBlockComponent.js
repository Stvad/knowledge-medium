import { BlockLoadingPlaceholder } from "./BlockLoadingPlaceholder.js";
import { LazyViewportMount } from "./util/LazyViewportMount.js";
import { BlockComponent } from "./BlockComponent.js";
import { c } from "react/compiler-runtime";
import { jsx } from "react/jsx-runtime";
//#region src/components/LazyBlockComponent.tsx
/**
* Renders a bullet-shaped placeholder until the block scrolls into (or
* near) the viewport, then swaps in the real `<BlockComponent>`.
*
* The recursive block tree is the natural rendering shape for an
* outliner, but mounting every descendant up-front is too expensive
* for large pages (each `BlockComponent` carries ~10 `useHandle`
* subscriptions through its renderer chain). This wrapper defers the
* heavy work to the moment a block is about to be seen, while keeping
* the recursive structure intact — backlinks, footers, and indentation
* all still come from the regular renderer path.
*
* Once mounted, a block stays mounted; we don't tear it back down on
* scroll-away. Re-mount churn would dominate any RAM win for a few
* hundred idle subscriptions.
*
* Layout stability is handled by the shared lazy viewport wrapper and
* block-shaped placeholder: each mounted block records its rendered
* height, and future placeholders for the same block reserve that size.
*
* Test/SSR fallback: the shared wrapper mounts immediately if
* `IntersectionObserver` isn't available.
*/
/** Reserved height for a not-yet-measured block. Picked to roughly
*  match a single-line bullet so the initial scrollHeight estimate is
*  close to reality; once a placeholder mounts, layout recomputes. */
var ESTIMATED_HEIGHT_PX = 32;
/** How far outside the viewport (in pixels, top + bottom) a block
*  should be before we mount it. Wider = more work pre-loaded; narrower
*  = more chance of seeing an empty placeholder during fast scrolls. */
var OVERSCAN_PX = 600;
function LazyBlockComponent(t0) {
	const $ = c(5);
	const { blockId } = t0;
	const t1 = `block:${blockId}`;
	let t2;
	if ($[0] !== blockId) {
		t2 = /* @__PURE__ */ jsx(BlockComponent, { blockId });
		$[0] = blockId;
		$[1] = t2;
	} else t2 = $[1];
	let t3;
	if ($[2] !== t1 || $[3] !== t2) {
		t3 = /* @__PURE__ */ jsx(LazyViewportMount, {
			cacheKey: t1,
			estimatedHeightPx: ESTIMATED_HEIGHT_PX,
			overscanPx: OVERSCAN_PX,
			renderPlaceholder: _temp,
			children: t2
		});
		$[2] = t1;
		$[3] = t2;
		$[4] = t3;
	} else t3 = $[4];
	return t3;
}
function _temp(t0) {
	const { reservedHeight } = t0;
	return /* @__PURE__ */ jsx(BlockLoadingPlaceholder, { reservedHeight });
}
//#endregion
export { LazyBlockComponent };

//# sourceMappingURL=LazyBlockComponent.js.map