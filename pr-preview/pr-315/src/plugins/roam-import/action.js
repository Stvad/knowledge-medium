import { runAnalyzeIfStale } from "../../data/internals/clientSchema.js";
import { scheduleIdle } from "../../utils/scheduleIdle.js";
import "../../data/maintenance.js";
import { showProgress } from "../../utils/toast.js";
import { ActionContextTypes } from "../../shortcuts/types.js";
import { parseAppHash } from "../../utils/routing.js";
import { importRoam } from "./import.js";
//#region src/plugins/roam-import/action.ts
var importRoamAction = ({ repo }) => ({
	id: "import_roam",
	description: "Import Roam JSON export",
	context: ActionContextTypes.GLOBAL,
	handler: () => {
		const input = document.createElement("input");
		input.type = "file";
		input.accept = ".json,application/json";
		input.onchange = async (e) => {
			const file = e.target.files?.[0];
			if (!file) return;
			const reader = new FileReader();
			reader.onload = async (loadEvent) => {
				const content = loadEvent.target?.result;
				if (typeof content !== "string") return;
				const banner = showProgress("Roam import: parsing JSON…");
				try {
					const parsed = JSON.parse(content);
					if (!Array.isArray(parsed)) {
						console.error("[roam-import] expected top-level JSON array of pages");
						banner.fail("Roam import failed: expected top-level JSON array of pages");
						return;
					}
					const workspaceId = parseAppHash(window.location.hash).workspaceId ?? repo.activeWorkspaceId;
					if (!workspaceId) {
						console.error("[roam-import] no active workspace");
						banner.fail("Roam import failed: no active workspace");
						return;
					}
					banner.update("Roam import: planning…");
					const summary = await importRoam(parsed, repo, {
						workspaceId,
						currentUserId: repo.user.id,
						onProgress: (msg) => {
							console.log(`[roam-import] ${msg}`);
							banner.update(`Roam import: ${msg}`);
						}
					});
					console.log("[roam-import] done", summary);
					banner.done(`Roam import complete: ${summary.pagesCreated} new pages, ${summary.pagesMerged} merged, ${summary.pagesDaily} daily, ${summary.blocksWritten} blocks (${(summary.durationMs / 1e3).toFixed(1)}s)`);
					scheduleIdle(() => {
						runAnalyzeIfStale(repo.db).catch((error) => {
							console.warn("[roam-import] ANALYZE check failed:", error);
						});
					});
				} catch (err) {
					console.error("[roam-import] failed:", err);
					banner.fail(`Roam import failed: ${err instanceof Error ? err.message : String(err)}`);
				}
			};
			reader.readAsText(file);
		};
		input.click();
	}
});
//#endregion
export { importRoamAction };

//# sourceMappingURL=action.js.map