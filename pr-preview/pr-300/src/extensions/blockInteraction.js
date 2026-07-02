import { editorSelection, focusBlock, requestEditorFocus } from "../data/properties.js";
import { combineLastContributionResult, defineFacet, isFunction } from "../facets/facet.js";
import { resetBlockSelection } from "../data/stateBlocks.js";
import { defineVariantFacet } from "../facets/variantFacet.js";
//#region src/extensions/blockInteraction.ts
var blockHeaderFacet = defineFacet({
	id: "core.block-header",
	combine: (contributions) => (context) => {
		const result = [];
		for (const contribution of contributions) {
			const renderer = contribution(context);
			if (renderer) result.push(renderer);
		}
		return result;
	},
	empty: () => () => [],
	validate: isFunction
});
var blockChildrenFooterFacet = defineFacet({
	id: "core.block-children-footer",
	combine: (contributions) => (context) => {
		const result = [];
		for (const contribution of contributions) {
			const renderer = contribution(context);
			if (renderer) result.push(renderer);
		}
		return result;
	},
	empty: () => () => [],
	validate: isFunction
});
var blockLayoutFacet = defineVariantFacet({ id: "core.block-layout" });
var blockShellDecoratorsFacet = defineFacet({
	id: "core.block-shell-decorators",
	combine: (contributions) => (context) => {
		const result = [];
		for (const contribution of contributions) {
			const decorator = contribution(context);
			if (decorator) result.push(decorator);
		}
		return result;
	},
	empty: () => () => [],
	validate: isFunction
});
var getBlockContentRendererSlot = (context, slotId) => context.contentRenderers?.find((slot) => slot.id === slotId)?.renderer;
var blockContentRendererFacet = defineVariantFacet({ id: "core.block-content-renderer" });
var blockContentDecoratorsFacet = defineFacet({
	id: "core.block-content-decorators",
	combine: (contributions) => (context, inner) => {
		let renderer = inner;
		for (const contribution of contributions) {
			const decorator = contribution(context);
			if (decorator) renderer = decorator(renderer);
		}
		return renderer;
	},
	empty: () => (_context, inner) => inner,
	validate: isFunction
});
var blockClickHandlersFacet = defineFacet({
	id: "core.block-click-handlers",
	combine: combineLastContributionResult(),
	empty: () => () => void 0,
	validate: isFunction
});
var mergeBlockContentSurfaceProps = (contributions, context) => {
	const merged = {};
	for (const contribution of contributions) {
		const props = contribution(context);
		if (!props) continue;
		for (const [key, value] of Object.entries(props)) {
			const existing = merged[key];
			if (typeof value === "function" && typeof existing === "function") {
				const prev = existing;
				const next = value;
				merged[key] = (...args) => {
					prev(...args);
					next(...args);
				};
			} else if (key === "className" && typeof value === "string" && typeof existing === "string") merged[key] = `${existing} ${value}`;
			else merged[key] = value;
		}
	}
	return merged;
};
var blockContentSurfacePropsFacet = defineFacet({
	id: "core.block-content-surface-props",
	combine: (contributions) => (context) => mergeBlockContentSurfaceProps(contributions, context),
	empty: () => () => ({}),
	validate: isFunction
});
var resolveShortcutActivations = (contributions, context) => contributions.flatMap((contribution) => contribution(context) || []);
var shortcutSurfaceActivationsFacet = defineFacet({
	id: "core.shortcut-surface-activations",
	combine: (contributions) => (context) => resolveShortcutActivations(contributions, context),
	empty: () => () => [],
	validate: isFunction
});
var interactiveContentSelector = [
	"a[href]",
	"button",
	"input",
	"select",
	"textarea",
	"summary",
	"details",
	"iframe",
	"object",
	"embed",
	"audio[controls]",
	"video[controls]",
	"[contenteditable=\"true\"]",
	"[role=\"button\"]",
	"[role=\"checkbox\"]",
	"[role=\"link\"]",
	"[role=\"menuitem\"]",
	"[role=\"option\"]",
	"[role=\"radio\"]",
	"[role=\"switch\"]",
	"[role=\"tab\"]",
	"[data-block-interaction=\"ignore\"]"
].join(",");
var isInteractiveContentEvent = (event) => {
	const target = event.target;
	if (typeof Node === "undefined" || !(target instanceof Node)) return false;
	const element = target.nodeType === Node.ELEMENT_NODE ? target : target.parentElement;
	return Boolean(element?.closest(interactiveContentSelector));
};
/**
* Enter edit mode for a block from its flat dependencies — the core used by
* both the `BlockResolveContext` wrapper below and the pointer-dispatched
* click-to-edit action (which only carries `{block, uiStateBlock, renderScopeId}`).
*/
var enterEditModeForBlock = async (block, uiStateBlock, renderScopeId, selection) => {
	if (uiStateBlock.repo.isReadOnly) {
		focusBlock(uiStateBlock, block.id, { renderScopeId });
		return;
	}
	await resetBlockSelection(uiStateBlock);
	await focusBlock(uiStateBlock, block.id, {
		edit: true,
		renderScopeId
	});
	if (selection) uiStateBlock.set(editorSelection, {
		blockId: block.id,
		...selection
	});
	requestEditorFocus(uiStateBlock);
};
var enterBlockEditMode = async (context, selection) => {
	const renderScopeId = typeof context.blockContext?.renderScopeId === "string" ? context.blockContext.renderScopeId : void 0;
	await enterEditModeForBlock(context.block, context.uiStateBlock, renderScopeId, selection);
};
/**
* Focus a block without entering edit mode, clearing any active block
* selection first — the "single click focuses" behaviour vim normal mode wants
* (and the plain-click branch of `handleBlockSelectionClick`). Operates on the
* flat deps a pointer-dispatched action carries.
*/
var focusBlockWithoutEditing = async (block, uiStateBlock, renderScopeId) => {
	await resetBlockSelection(uiStateBlock);
	focusBlock(uiStateBlock, block.id, renderScopeId ? { renderScopeId } : void 0);
};
var isSelectionClick = (event) => event.ctrlKey || event.metaKey || event.shiftKey;
/**
* Build the deps a pointer-dispatched block gesture needs from a block's
* resolve context plus the live event — the clicked/tapped block, the surface
* boundary, and the DOM node the event targeted. `currentTarget` is read
* synchronously here (the caller is still inside the React handler) because
* React nulls it once the handler returns, and pointer actions (the spatial
* selection walker) need the bound element to locate the gesture among visible
* blocks. Shared by the block shell's click path and the content surface's
* double-click/tap path so the supplied-deps shape stays in one place.
*/
var blockPointerDepsFrom = (context, event) => {
	const renderScopeId = typeof context.blockContext?.renderScopeId === "string" ? context.blockContext.renderScopeId : void 0;
	return {
		block: context.block,
		uiStateBlock: context.uiStateBlock,
		scopeRootId: context.scopeRootId,
		scopeRootForcesOpen: !context.blockContext?.isNestedSurface,
		targetElement: event.currentTarget,
		...renderScopeId ? { renderScopeId } : {}
	};
};
//#endregion
export { blockChildrenFooterFacet, blockClickHandlersFacet, blockContentDecoratorsFacet, blockContentRendererFacet, blockContentSurfacePropsFacet, blockHeaderFacet, blockLayoutFacet, blockPointerDepsFrom, blockShellDecoratorsFacet, enterBlockEditMode, enterEditModeForBlock, focusBlockWithoutEditing, getBlockContentRendererSlot, isInteractiveContentEvent, isSelectionClick, mergeBlockContentSurfaceProps, resolveShortcutActivations, shortcutSurfaceActivationsFacet };

//# sourceMappingURL=blockInteraction.js.map