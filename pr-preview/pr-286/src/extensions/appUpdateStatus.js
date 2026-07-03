import { actionsFacet } from "./core.js";
import { RefreshCw } from "../../node_modules/lucide-react/dist/esm/icons/refresh-cw.js";
import { ActionContextTypes } from "../shortcuts/types.js";
import { appUpdate } from "../appUpdate.js";
import { diagnosticsFacet } from "../plugins/diagnostics/facet.js";
//#region src/extensions/appUpdateStatus.ts
/**
* Routes "a new app build is available" onto the shared diagnostics seam, so
* the status indicator shows it generically (an ambient dot + a "Reload" row in
* the dropdown) instead of the chip hardcoding `appUpdate`. Pairs with the
* loud, dismissible toast in `appUpdateMount.tsx`; this is the quiet, always-
* there chip presence.
*
* The actual reload is a normal global action (`app.reload`) the dropdown
* button runs via `runActionById` — same indirection every diagnostic uses.
*/
var APP_RELOAD_ACTION_ID = "app.reload";
var appReloadAction = {
	id: APP_RELOAD_ACTION_ID,
	description: "Reload to apply the new version",
	context: ActionContextTypes.GLOBAL,
	icon: RefreshCw,
	isVisible: () => appUpdate.isAvailable(),
	handler: () => {
		appUpdate.reload();
	}
};
var UPDATE_AVAILABLE_SNAPSHOT = {
	severity: "info",
	summary: "A new version is available",
	actionId: APP_RELOAD_ACTION_ID,
	actionLabel: "Reload",
	nudge: true
};
var appUpdateDiagnosticSource = {
	id: "app-update",
	label: "App update",
	subscribe: appUpdate.subscribe,
	getSnapshot: () => appUpdate.isAvailable() ? UPDATE_AVAILABLE_SNAPSHOT : null
};
var appReloadActionContribution = actionsFacet.of(appReloadAction, { source: "app-update" });
var appUpdateDiagnosticContribution = diagnosticsFacet.of(appUpdateDiagnosticSource, { source: "app-update" });
//#endregion
export { APP_RELOAD_ACTION_ID, appReloadActionContribution, appUpdateDiagnosticContribution };

//# sourceMappingURL=appUpdateStatus.js.map