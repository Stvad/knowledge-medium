//#region src/data/api/blockType.ts
/** Display spread for types the tagging UX should never surface at
*  all: hidden from the `#` autocomplete AND from block chip display,
*  still visible in the property panel. For plumbing whose chip has no
*  on-block value (page — every block row lives on one; auto-managed
*  state tags like SRS progress). Plumbing whose chip IS informative
*  on the block itself (panel, user, prefs containers) sets only
*  `hideFromCompletion`. Spread it (`...INFRASTRUCTURE_TYPE_DISPLAY`)
*  rather than spelling the flags so a future display surface's flag
*  gets picked up in one place. */
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