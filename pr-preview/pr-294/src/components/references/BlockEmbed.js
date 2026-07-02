import { embedRenderScopeId, outlineRenderScopeId } from "../../utils/renderScope.js";
import { useRepo } from "../../context/repo.js";
import { useBlockExists } from "../../hooks/block.js";
import { NestedBlockContextProvider, useBlockContext } from "../../context/block.js";
import { BlockComponent } from "../BlockComponent.js";
import { BlockRefAncestorsProvider } from "./cycleGuard.js";
import { useBlockRefAncestors } from "./useBlockRefAncestors.js";
import { c } from "react/compiler-runtime";
import { jsx, jsxs } from "react/jsx-runtime";
//#region src/components/references/BlockEmbed.tsx
var EMBED_CONTEXT_OVERRIDES = {
	isNestedSurface: true,
	isEmbedded: true,
	isReference: false
};
function BlockEmbed(t0) {
	const $ = c(30);
	const { blockId, sourceBlockId, occurrenceId } = t0;
	const repo = useRepo();
	const ancestors = useBlockRefAncestors();
	const blockContext = useBlockContext();
	let t1;
	if ($[0] !== blockContext.renderScopeId || $[1] !== sourceBlockId) {
		t1 = typeof blockContext.renderScopeId === "string" ? blockContext.renderScopeId : outlineRenderScopeId(sourceBlockId);
		$[0] = blockContext.renderScopeId;
		$[1] = sourceBlockId;
		$[2] = t1;
	} else t1 = $[2];
	const parentRenderScopeId = t1;
	let t2;
	if ($[3] !== blockId || $[4] !== occurrenceId || $[5] !== parentRenderScopeId || $[6] !== sourceBlockId) {
		t2 = embedRenderScopeId(parentRenderScopeId, sourceBlockId, occurrenceId, blockId);
		$[3] = blockId;
		$[4] = occurrenceId;
		$[5] = parentRenderScopeId;
		$[6] = sourceBlockId;
		$[7] = t2;
	} else t2 = $[7];
	const renderScopeId = t2;
	let t3;
	if ($[8] !== blockId || $[9] !== repo) {
		t3 = repo.block(blockId);
		$[8] = blockId;
		$[9] = repo;
		$[10] = t3;
	} else t3 = $[10];
	if (!useBlockExists(t3)) {
		let t4;
		if ($[11] !== blockId) {
			t4 = blockId.slice(0, 8);
			$[11] = blockId;
			$[12] = t4;
		} else t4 = $[12];
		let t5;
		if ($[13] !== t4) {
			t5 = /* @__PURE__ */ jsxs("div", {
				className: "blockembed blockembed--unresolved border border-dashed border-muted-foreground/40 rounded p-2 my-1 text-sm text-muted-foreground",
				children: [
					"Embedded block not loaded yet ((",
					t4,
					"…))"
				]
			});
			$[13] = t4;
			$[14] = t5;
		} else t5 = $[14];
		return t5;
	}
	if (ancestors.has(blockId)) {
		let t4;
		if ($[15] !== blockId) {
			t4 = blockId.slice(0, 8);
			$[15] = blockId;
			$[16] = t4;
		} else t4 = $[16];
		let t5;
		if ($[17] !== t4) {
			t5 = /* @__PURE__ */ jsxs("div", {
				className: "blockembed blockembed--cycle border border-dashed border-amber-500/60 rounded p-2 my-1 text-sm text-amber-700",
				children: [
					"↻ Cycle detected — block ((",
					t4,
					"…)) already appears in the embed chain"
				]
			});
			$[17] = t4;
			$[18] = t5;
		} else t5 = $[18];
		return t5;
	}
	let t4;
	if ($[19] !== blockId || $[20] !== renderScopeId) {
		t4 = {
			...EMBED_CONTEXT_OVERRIDES,
			renderScopeId,
			scopeRootId: blockId
		};
		$[19] = blockId;
		$[20] = renderScopeId;
		$[21] = t4;
	} else t4 = $[21];
	let t5;
	if ($[22] !== blockId) {
		t5 = /* @__PURE__ */ jsx(BlockComponent, { blockId });
		$[22] = blockId;
		$[23] = t5;
	} else t5 = $[23];
	let t6;
	if ($[24] !== t4 || $[25] !== t5) {
		t6 = /* @__PURE__ */ jsx("div", {
			className: "blockembed border-l-2 border-muted pl-2 my-1 bg-muted/30 rounded-r",
			children: /* @__PURE__ */ jsx(NestedBlockContextProvider, {
				overrides: t4,
				children: t5
			})
		});
		$[24] = t4;
		$[25] = t5;
		$[26] = t6;
	} else t6 = $[26];
	let t7;
	if ($[27] !== blockId || $[28] !== t6) {
		t7 = /* @__PURE__ */ jsx(BlockRefAncestorsProvider, {
			ancestor: blockId,
			children: t6
		});
		$[27] = blockId;
		$[28] = t6;
		$[29] = t7;
	} else t7 = $[29];
	return t7;
}
//#endregion
export { BlockEmbed };

//# sourceMappingURL=BlockEmbed.js.map