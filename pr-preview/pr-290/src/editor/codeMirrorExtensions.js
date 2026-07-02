import { defineFacet, isFunction } from "../facets/facet.js";
//#region src/editor/codeMirrorExtensions.ts
var codeMirrorExtensionsFacet = defineFacet({
	id: "core.codemirror-extensions",
	combine: (contributions) => (context) => contributions.flatMap((contribution) => contribution(context)),
	empty: () => () => [],
	validate: isFunction
});
//#endregion
export { codeMirrorExtensionsFacet };

//# sourceMappingURL=codeMirrorExtensions.js.map