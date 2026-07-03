import { defineFacet } from "../../facets/facet.js";
//#region src/plugins/grouped-backlinks/facet.ts
var isGroupedBacklinksGroupHeaderAction = (value) => typeof value === "object" && value !== null && typeof value.actionId === "string";
var groupedBacklinksGroupHeaderActionsFacet = defineFacet({
	id: "grouped-backlinks.group-header-actions",
	validate: isGroupedBacklinksGroupHeaderAction
});
//#endregion
export { groupedBacklinksGroupHeaderActionsFacet };

//# sourceMappingURL=facet.js.map