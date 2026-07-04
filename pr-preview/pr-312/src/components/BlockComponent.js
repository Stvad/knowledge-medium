import { m } from "../../node_modules/react-error-boundary/dist/react-error-boundary.js";
import { useRepo } from "../context/repo.js";
import { useChildIds } from "../hooks/block.js";
import { useBlockContext } from "../context/block.js";
import { FallbackComponent } from "./util/error.js";
import { useRenderer } from "../hooks/useRendererRegistry.js";
import { BlockLoadingPlaceholder } from "./BlockLoadingPlaceholder.js";
import { LazyBlockComponent } from "./LazyBlockComponent.js";
import { Suspense } from "react";
import { c } from "react/compiler-runtime";
import { Fragment as Fragment$1, jsx } from "react/jsx-runtime";
//#region src/components/BlockComponent.tsx
function BlockComponent(t0) {
	const $ = c(11);
	const { blockId } = t0;
	const repo = useRepo();
	let t1;
	if ($[0] !== blockId || $[1] !== repo) {
		t1 = repo.block(blockId);
		$[0] = blockId;
		$[1] = repo;
		$[2] = t1;
	} else t1 = $[2];
	const block = t1;
	const context = useBlockContext();
	let t2;
	if ($[3] !== block || $[4] !== context) {
		t2 = {
			block,
			context
		};
		$[3] = block;
		$[4] = context;
		$[5] = t2;
	} else t2 = $[5];
	const Renderer = useRenderer(t2);
	let t3;
	if ($[6] === Symbol.for("react.memo_cache_sentinel")) {
		t3 = /* @__PURE__ */ jsx(BlockLoadingPlaceholder, {});
		$[6] = t3;
	} else t3 = $[6];
	let t4;
	if ($[7] !== Renderer || $[8] !== block || $[9] !== context) {
		t4 = /* @__PURE__ */ jsx(m, {
			FallbackComponent,
			children: /* @__PURE__ */ jsx(Suspense, {
				fallback: t3,
				children: /* @__PURE__ */ jsx(Renderer, {
					block,
					context
				})
			})
		});
		$[7] = Renderer;
		$[8] = block;
		$[9] = context;
		$[10] = t4;
	} else t4 = $[10];
	return t4;
}
/**
* An interesting idea here is to keep building the context as we go deeper,
* so push all the properties from the parent to the context - overrides would automatically happen in the hierarchy
* we can also add things like "youtube parent" and such
*
* two concerns:
* - memory usage
* - this diverges the behavior in ui vs pure block operation, given the block in isolation, we won't have the context
*
* youtube context seems more immediately meaningful/actionable
*/
var BlockChildren = (t0) => {
	const $ = c(4);
	const { block } = t0;
	const t1 = useChildIds(block);
	let t2;
	if ($[0] !== t1) {
		t2 = t1.map(_temp);
		$[0] = t1;
		$[1] = t2;
	} else t2 = $[1];
	let t3;
	if ($[2] !== t2) {
		t3 = /* @__PURE__ */ jsx(Fragment$1, { children: t2 });
		$[2] = t2;
		$[3] = t3;
	} else t3 = $[3];
	return t3;
};
function _temp(childId) {
	return /* @__PURE__ */ jsx(LazyBlockComponent, { blockId: childId }, childId);
}
//#endregion
export { BlockChildren, BlockComponent };

//# sourceMappingURL=BlockComponent.js.map