import { actionsFacet } from "../../extensions/core.js";
import { showInfo, showSuccess } from "../../utils/toast.js";
import { ShieldCheck } from "../../../node_modules/lucide-react/dist/esm/icons/shield-check.js";
import { ActionContextTypes } from "../../shortcuts/types.js";
import { getPersistenceState, requestPersistentStorage } from "../../requestPersistentStorage.js";
import { REQUEST_PERSISTENCE_ACTION_ID, persistenceDiagnosticSource, refreshPersistenceStatus } from "./persistenceStatus.js";
//#region src/plugins/storage-persistence/requestAction.ts
/**
* The "Protect" affordance behind the storage-persistence nudge: a global
* action the chip's dropdown button runs (and the command palette lists). It's
* the deliberate, user-initiated request — `{force: true}` bypasses the
* once-per-session boot gate — with a browser-aware result toast, because a
* `false` on a prompt-less engine (Chromium heuristics) is "not yet", not a
* hard failure.
*/
var requestPersistenceAction = {
	id: REQUEST_PERSISTENCE_ACTION_ID,
	description: "Protect local data (persistent storage)",
	context: ActionContextTypes.GLOBAL,
	icon: ShieldCheck,
	isVisible: () => persistenceDiagnosticSource.getSnapshot() !== null,
	handler: async () => {
		if (await requestPersistentStorage({ force: true })) showSuccess("Local data is now protected on this device — it won't be evicted automatically.");
		else {
			const { permission } = await getPersistenceState();
			if (permission === "denied") showInfo("Your browser is blocking storage for this site. Re-enable it in the browser's site settings to protect local data.");
			else showInfo("Your browser will protect this automatically as you keep using the app — or install it to your home screen / dock to lock it in now.");
		}
		await refreshPersistenceStatus();
	}
};
var requestPersistenceActionContribution = actionsFacet.of(requestPersistenceAction, { source: "storage-persistence" });
//#endregion
export { requestPersistenceActionContribution };

//# sourceMappingURL=requestAction.js.map