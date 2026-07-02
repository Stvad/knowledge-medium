import { keyedMapFacet } from "../../facets/facet.js";
//#region src/plugins/diagnostics/facet.ts
/**
* The diagnostics seam — a generic way for plugins to surface a health signal
* into a shared indicator (today the status chip), instead of each one
* wiring a bespoke store + chip coupling (the pre-seam shape the consistency
* audit had).
*
* Deliberately NOT in core: the only thing core truly owns is the indicator
* surface itself; the diagnostics concept lives in the plugin layer, so the
* facet is defined here and plugins contribute to it (and read it) by importing
* this module. A contribution is a small live store — `{subscribe, getSnapshot}`
* — because health is a changing signal; the aggregating chip does one
* `useSyncExternalStore` per source via `useDiagnostics`.
*/
/** Order used to pick the worst severity across all contributed sources. */
var SEVERITY_RANK = {
	ok: 0,
	info: 1,
	warning: 2,
	error: 3
};
var worstSeverity = (severities) => severities.reduce((worst, s) => SEVERITY_RANK[s] > SEVERITY_RANK[worst] ? s : worst, "ok");
var diagnosticsFacet = keyedMapFacet("diagnostics.sources", (c) => c.id);
//#endregion
export { SEVERITY_RANK, diagnosticsFacet, worstSeverity };

//# sourceMappingURL=facet.js.map