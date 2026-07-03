import { getOrCreateKernelPage, kernelPageBlockId } from "../../data/kernelPage.js";
import "./blockTypes.js";
//#region src/plugins/geo/locationsPage.ts
var LOCATIONS_PAGE_NS = "f9c4e2a8-3b71-4d6e-9f8a-2c5b8e1d4a7f";
var LOCATIONS_ALIAS = "Locations";
var locationsPageBlockId = (workspaceId) => kernelPageBlockId(workspaceId, LOCATIONS_PAGE_NS);
var getOrCreateLocationsPage = (repo, workspaceId) => getOrCreateKernelPage(repo, workspaceId, {
	namespace: LOCATIONS_PAGE_NS,
	alias: LOCATIONS_ALIAS,
	markerType: "map"
});
//#endregion
export { getOrCreateLocationsPage, locationsPageBlockId };

//# sourceMappingURL=locationsPage.js.map