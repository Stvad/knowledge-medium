import { backlinkRenderScopeId } from "../../utils/renderScope.js";
import { useRepo } from "../../context/repo.js";
import { useParents } from "../../hooks/block.js";
import { NestedBlockContextProvider, useBlockContext } from "../../context/block.js";
import { BlockLoadingPlaceholder } from "../../components/BlockLoadingPlaceholder.js";
import { LazyViewportMount } from "../../components/util/LazyViewportMount.js";
import { BlockComponent } from "../../components/BlockComponent.js";
import { PromotableBreadcrumbList } from "../breadcrumbs/PromotableBreadcrumbList.js";
import { usePromotableBreadcrumb } from "../breadcrumbs/usePromotableBreadcrumb.js";
import { backlinkEntryShortcutContextOverrides, promoteClosestBreadcrumb } from "./backlinkBreadcrumbShortcuts.js";
import { c } from "react/compiler-runtime";
import { Fragment, jsx, jsxs } from "react/jsx-runtime";
//#region src/plugins/backlinks/BacklinkEntry.tsx
var NESTED_OVERRIDES = {
	layoutBoundary: false,
	isNestedSurface: true,
	isBacklink: true
};
var BREADCRUMB_OVERRIDES = {
	...NESTED_OVERRIDES,
	isBreadcrumb: true
};
var BACKLINK_ESTIMATED_HEIGHT_PX = 96;
var BACKLINK_OVERSCAN_PX = 600;
var BACKLINK_BLOCK_PLACEHOLDER_HEIGHT_PX = 32;
var EMPTY_PARENTS = [];
var BacklinkItemContent = (t0) => {
	const $ = c(26);
	const { shownBlock, parents, onSelect, onShowBlock, renderScopeId } = t0;
	const workspaceId = useRepo().activeWorkspaceId;
	let t1;
	if ($[0] !== onShowBlock || $[1] !== parents) {
		t1 = () => promoteClosestBreadcrumb(parents, onShowBlock);
		$[0] = onShowBlock;
		$[1] = parents;
		$[2] = t1;
	} else t1 = $[2];
	const promoteBreadcrumb = t1;
	let t2;
	if ($[3] !== parents) {
		t2 = () => parents.length > 0;
		$[3] = parents;
		$[4] = t2;
	} else t2 = $[4];
	const hasBreadcrumb = t2;
	let t3;
	if ($[5] !== hasBreadcrumb || $[6] !== promoteBreadcrumb) {
		t3 = {
			promoteClosestBreadcrumb: promoteBreadcrumb,
			hasBreadcrumb
		};
		$[5] = hasBreadcrumb;
		$[6] = promoteBreadcrumb;
		$[7] = t3;
	} else t3 = $[7];
	const shortcutController = t3;
	const t4 = shownBlock.id;
	let t5;
	if ($[8] !== shortcutController) {
		t5 = backlinkEntryShortcutContextOverrides(shortcutController);
		$[8] = shortcutController;
		$[9] = t5;
	} else t5 = $[9];
	let t6;
	if ($[10] !== renderScopeId || $[11] !== shownBlock.id || $[12] !== t5) {
		t6 = {
			...NESTED_OVERRIDES,
			renderScopeId,
			scopeRootId: t4,
			...t5
		};
		$[10] = renderScopeId;
		$[11] = shownBlock.id;
		$[12] = t5;
		$[13] = t6;
	} else t6 = $[13];
	const bodyOverrides = t6;
	let t7;
	if ($[14] !== onSelect || $[15] !== parents || $[16] !== workspaceId) {
		t7 = workspaceId && /* @__PURE__ */ jsx(PromotableBreadcrumbList, {
			parents,
			workspaceId,
			overrides: BREADCRUMB_OVERRIDES,
			onPromote: onSelect,
			className: "flex items-center gap-1 text-xs text-muted-foreground/80 mb-1 flex-wrap",
			itemClassName: "no-underline cursor-pointer truncate max-w-[24ch] hover:text-foreground",
			separatorClassName: "mx-1 text-muted-foreground/40"
		});
		$[14] = onSelect;
		$[15] = parents;
		$[16] = workspaceId;
		$[17] = t7;
	} else t7 = $[17];
	let t8;
	if ($[18] !== shownBlock.id) {
		t8 = /* @__PURE__ */ jsx(BlockComponent, { blockId: shownBlock.id });
		$[18] = shownBlock.id;
		$[19] = t8;
	} else t8 = $[19];
	let t9;
	if ($[20] !== bodyOverrides || $[21] !== t8) {
		t9 = /* @__PURE__ */ jsx(NestedBlockContextProvider, {
			overrides: bodyOverrides,
			children: t8
		});
		$[20] = bodyOverrides;
		$[21] = t8;
		$[22] = t9;
	} else t9 = $[22];
	let t10;
	if ($[23] !== t7 || $[24] !== t9) {
		t10 = /* @__PURE__ */ jsxs(Fragment, { children: [t7, t9] });
		$[23] = t7;
		$[24] = t9;
		$[25] = t10;
	} else t10 = $[25];
	return t10;
};
var BacklinkDynamicContent = (t0) => {
	const $ = c(6);
	const { shownBlock, onSelect, onShowBlock, renderScopeId } = t0;
	const parents = useParents(shownBlock);
	let t1;
	if ($[0] !== onSelect || $[1] !== onShowBlock || $[2] !== parents || $[3] !== renderScopeId || $[4] !== shownBlock) {
		t1 = /* @__PURE__ */ jsx(BacklinkItemContent, {
			shownBlock,
			parents,
			onSelect,
			onShowBlock,
			renderScopeId
		});
		$[0] = onSelect;
		$[1] = onShowBlock;
		$[2] = parents;
		$[3] = renderScopeId;
		$[4] = shownBlock;
		$[5] = t1;
	} else t1 = $[5];
	return t1;
};
var BacklinkItem = (t0) => {
	const $ = c(13);
	const { block, initialParents: t1, scopeId } = t0;
	const initialParents = t1 === void 0 ? EMPTY_PARENTS : t1;
	const repo = useRepo();
	const parentContext = useBlockContext();
	const { shownId, isInitial, promote, showBlock } = usePromotableBreadcrumb(block.id);
	let t2;
	if ($[0] !== repo || $[1] !== shownId) {
		t2 = repo.block(shownId);
		$[0] = repo;
		$[1] = shownId;
		$[2] = t2;
	} else t2 = $[2];
	const shownBlock = t2;
	const parentRenderScopeId = typeof parentContext.renderScopeId === "string" ? parentContext.renderScopeId : "backlinks-root";
	let t3;
	if ($[3] !== parentRenderScopeId || $[4] !== scopeId) {
		t3 = backlinkRenderScopeId(parentRenderScopeId, scopeId);
		$[3] = parentRenderScopeId;
		$[4] = scopeId;
		$[5] = t3;
	} else t3 = $[5];
	const renderScopeId = t3;
	let t4;
	if ($[6] !== initialParents || $[7] !== isInitial || $[8] !== promote || $[9] !== renderScopeId || $[10] !== showBlock || $[11] !== shownBlock) {
		t4 = /* @__PURE__ */ jsx("div", {
			className: "border-l-2 border-muted pl-3 py-2",
			children: isInitial ? /* @__PURE__ */ jsx(BacklinkItemContent, {
				shownBlock,
				parents: initialParents,
				onSelect: promote,
				onShowBlock: showBlock,
				renderScopeId
			}) : /* @__PURE__ */ jsx(BacklinkDynamicContent, {
				shownBlock,
				onSelect: promote,
				onShowBlock: showBlock,
				renderScopeId
			})
		});
		$[6] = initialParents;
		$[7] = isInitial;
		$[8] = promote;
		$[9] = renderScopeId;
		$[10] = showBlock;
		$[11] = shownBlock;
		$[12] = t4;
	} else t4 = $[12];
	return t4;
};
var BacklinkItemPlaceholder = (t0) => {
	const $ = c(6);
	const { reservedHeight } = t0;
	let t1;
	if ($[0] !== reservedHeight) {
		t1 = { minHeight: reservedHeight };
		$[0] = reservedHeight;
		$[1] = t1;
	} else t1 = $[1];
	let t2;
	let t3;
	if ($[2] === Symbol.for("react.memo_cache_sentinel")) {
		t2 = /* @__PURE__ */ jsx("div", { className: "mb-1 h-4 w-40 max-w-full rounded-sm bg-muted/60" });
		t3 = /* @__PURE__ */ jsx(BlockLoadingPlaceholder, { reservedHeight: BACKLINK_BLOCK_PLACEHOLDER_HEIGHT_PX });
		$[2] = t2;
		$[3] = t3;
	} else {
		t2 = $[2];
		t3 = $[3];
	}
	let t4;
	if ($[4] !== t1) {
		t4 = /* @__PURE__ */ jsxs("div", {
			className: "border-l-2 border-muted pl-3 py-2",
			style: t1,
			"aria-hidden": true,
			children: [t2, t3]
		});
		$[4] = t1;
		$[5] = t4;
	} else t4 = $[5];
	return t4;
};
var LazyBacklinkItem = (t0) => {
	const $ = c(7);
	const { block, initialParents, scopeId } = t0;
	const t1 = `backlink:${scopeId}:${block.id}`;
	let t2;
	if ($[0] !== block || $[1] !== initialParents || $[2] !== scopeId) {
		t2 = /* @__PURE__ */ jsx(BacklinkItem, {
			block,
			initialParents,
			scopeId
		});
		$[0] = block;
		$[1] = initialParents;
		$[2] = scopeId;
		$[3] = t2;
	} else t2 = $[3];
	let t3;
	if ($[4] !== t1 || $[5] !== t2) {
		t3 = /* @__PURE__ */ jsx(LazyViewportMount, {
			cacheKey: t1,
			estimatedHeightPx: BACKLINK_ESTIMATED_HEIGHT_PX,
			overscanPx: BACKLINK_OVERSCAN_PX,
			renderPlaceholder: _temp,
			children: t2
		});
		$[4] = t1;
		$[5] = t2;
		$[6] = t3;
	} else t3 = $[6];
	return t3;
};
function _temp(props) {
	return /* @__PURE__ */ jsx(BacklinkItemPlaceholder, { ...props });
}
//#endregion
export { LazyBacklinkItem };

//# sourceMappingURL=BacklinkEntry.js.map