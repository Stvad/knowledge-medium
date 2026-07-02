import { dedupById, defineFacet } from "../../facets/facet.js";
//#region src/plugins/left-sidebar/facet.ts
var isRecord = (value) => typeof value === "object" && value !== null;
var isLeftSidebarSectionContribution = (value) => isRecord(value) && typeof value.id === "string" && typeof value.component === "function";
var leftSidebarSectionsFacet = defineFacet({
	id: "left-sidebar.sections",
	combine: dedupById("left-sidebar.sections"),
	validate: isLeftSidebarSectionContribution
});
//#endregion
export { isLeftSidebarSectionContribution, leftSidebarSectionsFacet };

//# sourceMappingURL=facet.js.map