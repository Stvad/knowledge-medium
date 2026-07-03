import { planImport } from "./plan.js";
import { importRoam } from "./import.js";
//#region src/plugins/roam-import/runtime.ts
var installed = false;
var ensureRoamImportWindowHook = (repo) => {
	if (installed) return;
	installed = true;
	window.__omniliner = window.__omniliner ?? {};
	window.__omniliner.roamImport = {
		run: (pages, options = {}) => {
			const workspaceId = options.workspaceId ?? repo.activeWorkspaceId;
			if (!workspaceId) throw new Error("No active workspace; pass {workspaceId} or set repo.activeWorkspaceId");
			return importRoam(pages, repo, {
				workspaceId,
				currentUserId: options.currentUserId ?? repo.user.id,
				dryRun: options.dryRun,
				onProgress: options.onProgress ?? ((msg) => console.log(`[roam-import] ${msg}`))
			});
		},
		plan: planImport
	};
};
//#endregion
export { ensureRoamImportWindowHook };

//# sourceMappingURL=runtime.js.map