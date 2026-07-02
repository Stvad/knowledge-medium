import { ensureRoamImportWindowHook } from "./runtime.js";
//#region src/plugins/roam-import/effect.ts
/** Installs `window.__omniliner.roamImport` once per Repo so the agent
*  runtime / devtools console can kick off an import without the file
*  picker. `ensureRoamImportWindowHook` is idempotent — the AppEffect
*  surface re-runs across plugin reloads without leaking handlers. */
var roamImportWindowHookEffect = {
	id: "roam-import.window-hook",
	start: ({ repo }) => {
		ensureRoamImportWindowHook(repo);
	}
};
//#endregion
export { roamImportWindowHookEffect };

//# sourceMappingURL=effect.js.map