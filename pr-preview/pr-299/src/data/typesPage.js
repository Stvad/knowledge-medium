import { TYPES_PAGE_TYPE } from "./blockTypes.js";
import { getOrCreateKernelPage, kernelPageBlockId } from "./kernelPage.js";
//#region src/data/typesPage.ts
var TYPES_PAGE_NS = "fd2c1ba0-7c4e-49f7-8a6b-4d56b3e3a5c7";
var TYPES_ALIAS = "Types";
var typesPageBlockId = (workspaceId) => kernelPageBlockId(workspaceId, TYPES_PAGE_NS);
var getOrCreateTypesPage = (repo, workspaceId) => getOrCreateKernelPage(repo, workspaceId, {
	namespace: TYPES_PAGE_NS,
	alias: TYPES_ALIAS,
	markerType: TYPES_PAGE_TYPE
});
//#endregion
export { getOrCreateTypesPage, typesPageBlockId };

//# sourceMappingURL=typesPage.js.map