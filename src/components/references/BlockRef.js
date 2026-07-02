import { embedRenderScopeId, outlineRenderScopeId } from "../../utils/renderScope.js";
import { useRepo } from "../../context/repo.js";
import { useBlockExists } from "../../hooks/block.js";
import { NestedBlockContextProvider, useBlockContext } from "../../context/block.js";
import { BlockComponent } from "../BlockComponent.js";
import { BlockRefAncestorsProvider } from "./cycleGuard.js";
import { useBlockRefAncestors } from "./useBlockRefAncestors.js";
import { ReferenceLink } from "./ReferenceLink.js";
import { c } from "react/compiler-runtime";
import { jsx, jsxs } from "react/jsx-runtime";
//#region src/components/references/BlockRef.tsx
var REFERENCE_CONTEXT_OVERRIDES = {
	isNestedSurface: true,
	isReference: true
};
var hasDisplayChildren = (children) => children !== void 0 && children !== null && (!Array.isArray(children) || children.length > 0);
var shortBlockRef = (blockId) => `((${blockId.slice(0, 8)}…))`;
/**
* Inline block reference (`((id))`). A reference is the SAME block, rendered
* through the one block-rendering pipeline with the reference layout (which
* picks the block's raw content and wraps it in a navigating link). This thin
* entry only handles the states that must short-circuit *before* mounting the
* target: unresolved, cycle, and the alias case (where a human-typed display
* string replaces the content, so there's no reason to mount the target at
* all). Everything else flows into `BlockComponent`.
*/
function BlockRef(t0) {
	const $ = c(36);
	const { blockId, sourceBlockId, occurrenceId, children } = t0;
	const repo = useRepo();
	const blockContext = useBlockContext();
	const ancestors = useBlockRefAncestors();
	let t1;
	if ($[0] !== blockId || $[1] !== repo) {
		t1 = repo.block(blockId);
		$[0] = blockId;
		$[1] = repo;
		$[2] = t1;
	} else t1 = $[2];
	const target = t1;
	const targetExists = useBlockExists(target);
	const display = hasDisplayChildren(children) ? children : null;
	if (!targetExists) {
		let t2;
		if ($[3] !== blockId || $[4] !== display) {
			t2 = display ?? shortBlockRef(blockId);
			$[3] = blockId;
			$[4] = display;
			$[5] = t2;
		} else t2 = $[5];
		let t3;
		if ($[6] !== t2) {
			t3 = /* @__PURE__ */ jsx("span", {
				className: "blockref blockref--unresolved",
				children: t2
			});
			$[6] = t2;
			$[7] = t3;
		} else t3 = $[7];
		return t3;
	}
	if (ancestors.has(blockId)) {
		let t2;
		if ($[8] !== blockId || $[9] !== display) {
			t2 = display ?? shortBlockRef(blockId);
			$[8] = blockId;
			$[9] = display;
			$[10] = t2;
		} else t2 = $[10];
		let t3;
		if ($[11] !== t2) {
			t3 = /* @__PURE__ */ jsxs("span", {
				className: "blockref blockref--cycle",
				title: "Cycle: this block already appears in the ref chain",
				children: ["↻ ", t2]
			});
			$[11] = t2;
			$[12] = t3;
		} else t3 = $[12];
		return t3;
	}
	if (display) {
		let t2;
		if ($[13] !== display || $[14] !== target) {
			t2 = /* @__PURE__ */ jsx(ReferenceLink, {
				block: target,
				children: display
			});
			$[13] = display;
			$[14] = target;
			$[15] = t2;
		} else t2 = $[15];
		return t2;
	}
	let t2;
	if ($[16] !== blockContext.renderScopeId || $[17] !== blockId || $[18] !== sourceBlockId) {
		t2 = typeof blockContext.renderScopeId === "string" ? blockContext.renderScopeId : outlineRenderScopeId(sourceBlockId ?? blockId);
		$[16] = blockContext.renderScopeId;
		$[17] = blockId;
		$[18] = sourceBlockId;
		$[19] = t2;
	} else t2 = $[19];
	const parentRenderScopeId = t2;
	const t3 = sourceBlockId ?? blockId;
	const t4 = occurrenceId ?? "unknown";
	let t5;
	if ($[20] !== blockId || $[21] !== parentRenderScopeId || $[22] !== t3 || $[23] !== t4) {
		t5 = embedRenderScopeId(parentRenderScopeId, t3, t4, blockId);
		$[20] = blockId;
		$[21] = parentRenderScopeId;
		$[22] = t3;
		$[23] = t4;
		$[24] = t5;
	} else t5 = $[24];
	const renderScopeId = t5;
	let t6;
	if ($[25] !== blockId || $[26] !== renderScopeId) {
		t6 = {
			...REFERENCE_CONTEXT_OVERRIDES,
			renderScopeId,
			scopeRootId: blockId
		};
		$[25] = blockId;
		$[26] = renderScopeId;
		$[27] = t6;
	} else t6 = $[27];
	let t7;
	if ($[28] !== blockId) {
		t7 = /* @__PURE__ */ jsx(BlockComponent, { blockId });
		$[28] = blockId;
		$[29] = t7;
	} else t7 = $[29];
	let t8;
	if ($[30] !== t6 || $[31] !== t7) {
		t8 = /* @__PURE__ */ jsx(NestedBlockContextProvider, {
			overrides: t6,
			children: t7
		});
		$[30] = t6;
		$[31] = t7;
		$[32] = t8;
	} else t8 = $[32];
	let t9;
	if ($[33] !== blockId || $[34] !== t8) {
		t9 = /* @__PURE__ */ jsx(BlockRefAncestorsProvider, {
			ancestor: blockId,
			children: t8
		});
		$[33] = blockId;
		$[34] = t8;
		$[35] = t9;
	} else t9 = $[35];
	return t9;
}
//#endregion
export { BlockRef };

//# sourceMappingURL=BlockRef.js.map