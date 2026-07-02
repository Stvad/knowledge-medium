//#region src/plugins/swipe-quick-actions/anchor.ts
var escapeCssIdent = (value) => {
	if (typeof CSS !== "undefined" && typeof CSS.escape === "function") return CSS.escape(value);
	return value.replace(/[^a-zA-Z0-9_-]/g, "\\$&");
};
var blockSelector = (blockId, renderScopeId) => `[data-block-id="${escapeCssIdent(blockId)}"]` + (renderScopeId ? `[data-render-scope-id="${escapeCssIdent(renderScopeId)}"]` : "");
var findSwipeActionBlockElement = (panelRoot, blockId, renderScopeId) => {
	const matches = Array.from(panelRoot.querySelectorAll(blockSelector(blockId, renderScopeId)));
	return matches.find((element) => element.classList.contains("tm-block")) ?? matches.find((element) => element.querySelector(".block-content")) ?? matches[0] ?? null;
};
var findSwipeActionAnchorElement = (panelRoot, blockId, renderScopeId) => {
	const blockElement = findSwipeActionBlockElement(panelRoot, blockId, renderScopeId);
	return blockElement?.querySelector(".block-content") ?? blockElement;
};
var getSwipeActionAnchorRect = (panelRoot, blockId, renderScopeId) => {
	const element = findSwipeActionAnchorElement(panelRoot, blockId, renderScopeId);
	if (!element) return null;
	const rect = element.getBoundingClientRect();
	return {
		top: rect.top,
		height: rect.height
	};
};
//#endregion
export { blockSelector, findSwipeActionAnchorElement, findSwipeActionBlockElement, getSwipeActionAnchorRect };

//# sourceMappingURL=anchor.js.map