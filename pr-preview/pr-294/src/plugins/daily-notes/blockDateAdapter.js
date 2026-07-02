import { defineFacet } from "../../facets/facet.js";
//#region src/plugins/daily-notes/blockDateAdapter.ts
var isBlockDateAdapter = (value) => typeof value === "object" && value !== null && typeof value.id === "string" && typeof value.canHandle === "function" && typeof value.getCurrentIso === "function" && typeof value.setIso === "function";
var blockDateAdapterFacet = defineFacet({
	id: "daily-notes.block-date-adapter",
	validate: isBlockDateAdapter
});
/** First adapter (in precedence order) whose `canHandle` returns true,
*  or null if none apply. The picker / scrub gesture call this once
*  when they activate; the chosen adapter handles both the initial read
*  and the eventual commit. */
var pickBlockDateAdapter = (runtime, block) => {
	const adapters = runtime.read(blockDateAdapterFacet);
	for (const adapter of adapters) if (adapter.canHandle(block)) return adapter;
	return null;
};
var hasAnyBlockDateAdapter = (runtime, block) => pickBlockDateAdapter(runtime, block) !== null;
//#endregion
export { blockDateAdapterFacet, hasAnyBlockDateAdapter, pickBlockDateAdapter };

//# sourceMappingURL=blockDateAdapter.js.map