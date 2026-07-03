//#region src/utils/lastWorkspace.ts
var LAST_WORKSPACE_STORAGE_KEY = "ftm.lastWorkspaceId";
var rememberWorkspace = (workspaceId) => {
	try {
		window.localStorage.setItem(LAST_WORKSPACE_STORAGE_KEY, workspaceId);
	} catch {}
};
var recallRememberedWorkspace = () => {
	try {
		return window.localStorage.getItem(LAST_WORKSPACE_STORAGE_KEY) ?? void 0;
	} catch {
		return;
	}
};
var forgetRememberedWorkspace = () => {
	try {
		window.localStorage.removeItem(LAST_WORKSPACE_STORAGE_KEY);
	} catch {}
};
//#endregion
export { forgetRememberedWorkspace, recallRememberedWorkspace, rememberWorkspace };

//# sourceMappingURL=lastWorkspace.js.map