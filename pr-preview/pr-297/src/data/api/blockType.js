//#region src/data/api/blockType.ts
/** Display spread for infrastructure types — kernel structure (page,
*  panel, …) and plugin plumbing (prefs / ui-state containers,
*  auto-managed state tags): hidden from the `#` autocomplete AND from
*  block chip display, still visible in the property panel. Spread it
*  (`...INFRASTRUCTURE_TYPE_DISPLAY`) rather than spelling the flags so
*  a future display surface's flag gets picked up in one place. */
var INFRASTRUCTURE_TYPE_DISPLAY = {
	hideFromCompletion: true,
	hideFromBlockDisplay: true
};
/** Identity helper for definition-site inference. Registration still
*  happens through `typesFacet.of(...)`. */
var defineBlockType = (def) => def;
//#endregion
export { INFRASTRUCTURE_TYPE_DISPLAY, defineBlockType };

//# sourceMappingURL=blockType.js.map