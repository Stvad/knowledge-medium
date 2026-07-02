import { dedupById, defineFacet, keyedMapFacet } from "../facets/facet.js";
//#region src/extensions/core.ts
var isRecord = (value) => typeof value === "object" && value !== null;
var isStringArray = (value) => Array.isArray(value) && value.every((item) => typeof item === "string");
var isRendererContribution = (value) => isRecord(value) && typeof value.id === "string" && typeof value.renderer === "function" && (value.aliases === void 0 || isStringArray(value.aliases));
var isActionContextType = (value) => typeof value === "string" && value.length > 0;
var isShortcutKeys = (value) => typeof value === "string" || isStringArray(value);
var isShortcutBindingInput = (value) => isRecord(value) && isShortcutKeys(value.keys) && (value.eventOptions === void 0 || isRecord(value.eventOptions));
var isActionConfig = (value) => isRecord(value) && typeof value.id === "string" && typeof value.description === "string" && isActionContextType(value.context) && typeof value.handler === "function" && (value.defaultBinding === void 0 || isShortcutBindingInput(value.defaultBinding));
var isActionTransform = (value) => isRecord(value) && typeof value.actionId === "string" && (value.context === void 0 || isActionContextType(value.context)) && typeof value.apply === "function";
var createRendererRegistry = (contributions) => {
	const registry = {};
	for (const contribution of contributions) {
		registry[contribution.id] = contribution.renderer;
		for (const alias of contribution.aliases ?? []) registry[alias] = contribution.renderer;
	}
	return registry;
};
var blockRenderersFacet = defineFacet({
	id: "core.block-renderers",
	combine: createRendererRegistry,
	empty: () => ({}),
	validate: isRendererContribution
});
var actionsFacet = defineFacet({
	id: "core.actions",
	validate: isActionConfig
});
/**
* The one facet for contributing action transforms (replace / wrap /
* unbind). The effective-actions pipeline runs every contribution in a
* single ordered pass.
*/
var actionTransformsFacet = defineFacet({
	id: "core.action-transforms",
	validate: isActionTransform
});
var isAppEffect = (value) => isRecord(value) && typeof value.id === "string" && typeof value.start === "function";
var appEffectsFacet = defineFacet({
	id: "core.app-effects",
	validate: isAppEffect
});
var isAppMountContribution = (value) => isRecord(value) && typeof value.id === "string" && typeof value.component === "function";
var appMountsFacet = defineFacet({
	id: "core.app-mounts",
	combine: dedupById("core.app-mounts"),
	validate: isAppMountContribution
});
var rejectionToastFacet = keyedMapFacet("core.rejection-toasts", (c) => c.code);
var isPanelMountContribution = (value) => isRecord(value) && typeof value.id === "string" && typeof value.component === "function";
var panelMountsFacet = defineFacet({
	id: "core.panel-mounts",
	combine: dedupById("core.panel-mounts"),
	validate: isPanelMountContribution
});
var isHeaderItemRegion = (value) => value === "start" || value === "end";
var isHeaderItemContribution = (value) => isRecord(value) && typeof value.id === "string" && isHeaderItemRegion(value.region) && typeof value.component === "function";
var headerItemsFacet = defineFacet({
	id: "core.header-items",
	combine: dedupById("core.header-items", (item) => `${item.region}:${item.id}`),
	validate: isHeaderItemContribution
});
var isActionContextConfig = (value) => isRecord(value) && isActionContextType(value.type) && typeof value.displayName === "string" && (value.defaultEventOptions === void 0 || isRecord(value.defaultEventOptions)) && (value.eventFilter === void 0 || typeof value.eventFilter === "function") && typeof value.validateDependencies === "function";
var actionContextsFacet = defineFacet({
	id: "core.action-contexts",
	validate: isActionContextConfig
});
/** Plugins contribute landing resolvers; App.tsx tries them in order
*  on bootstrap-with-empty-layout and uses the first non-null result.
*  `FacetRuntime` sorts contributions ascending by `precedence`
*  (default 0) before passing them here, so the highest-precedence
*  resolver ends up LAST in the returned array; App.tsx walks the
*  array in reverse so high-precedence wins. Without contributions the
*  bootstrap leaves the layout empty — the panel projection then
*  renders an empty panel stack, which is the historical fallback. */
var workspaceLandingFacet = defineFacet({
	id: "core.workspace-landing",
	validate: (value) => typeof value === "function"
});
//#endregion
export { actionContextsFacet, actionTransformsFacet, actionsFacet, appEffectsFacet, appMountsFacet, blockRenderersFacet, createRendererRegistry, headerItemsFacet, isActionConfig, isActionContextConfig, isAppEffect, isAppMountContribution, isHeaderItemContribution, isPanelMountContribution, isRendererContribution, panelMountsFacet, rejectionToastFacet, workspaceLandingFacet };

//# sourceMappingURL=core.js.map