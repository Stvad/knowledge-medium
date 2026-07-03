import { defineVerbFacet } from "../facets/verbFacet.js";
//#region src/paste/captureMediaVerb.ts
var NOTHING = { references: [] };
var captureMediaVerb = defineVerbFacet({
	id: "paste.capture-media",
	defaultImpl: () => NOTHING,
	onError: "rethrow"
});
//#endregion
export { captureMediaVerb };

//# sourceMappingURL=captureMediaVerb.js.map