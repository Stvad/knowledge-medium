import { PROPERTIES_PAGE_TYPE } from "./blockTypes.js";
import { getOrCreateKernelPage, kernelPageBlockId } from "./kernelPage.js";
//#region src/data/propertiesPage.ts
var PROPERTIES_PAGE_NS = "94f9a6d9-c651-4b75-aef3-a5c1bbef0e1a";
var PROPERTIES_ALIAS = "Properties";
var propertiesPageBlockId = (workspaceId) => kernelPageBlockId(workspaceId, PROPERTIES_PAGE_NS);
var getOrCreatePropertiesPage = (repo, workspaceId) => getOrCreateKernelPage(repo, workspaceId, {
	namespace: PROPERTIES_PAGE_NS,
	alias: PROPERTIES_ALIAS,
	markerType: PROPERTIES_PAGE_TYPE
});
//#endregion
export { getOrCreatePropertiesPage, propertiesPageBlockId };

//# sourceMappingURL=propertiesPage.js.map