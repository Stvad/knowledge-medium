import { RECENTS_PAGE_TYPE } from "./blockTypes.js";
import { getOrCreateKernelPage, kernelPageBlockId } from "./kernelPage.js";
//#region src/data/recentsPage.ts
var RECENTS_PAGE_NS = "4f2c8d61-1a35-4a90-8b6f-2a3a0c8d9b41";
var RECENTS_ALIAS = "Recents";
var recentsPageBlockId = (workspaceId) => kernelPageBlockId(workspaceId, RECENTS_PAGE_NS);
var getOrCreateRecentsPage = (repo, workspaceId) => getOrCreateKernelPage(repo, workspaceId, {
	namespace: RECENTS_PAGE_NS,
	alias: RECENTS_ALIAS,
	markerType: RECENTS_PAGE_TYPE
});
//#endregion
export { getOrCreateRecentsPage, recentsPageBlockId };

//# sourceMappingURL=recentsPage.js.map