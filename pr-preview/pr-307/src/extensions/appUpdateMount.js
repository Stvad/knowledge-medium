import { systemToggle } from "../facets/togglable.js";
import { appMountsFacet } from "./core.js";
import { dismissToast, showInfo } from "../utils/toast.js";
import { appUpdate, useAppUpdateAvailable } from "../appUpdate.js";
import { appReloadActionContribution, appUpdateDiagnosticContribution } from "./appUpdateStatus.js";
import { useEffect } from "react";
import { c } from "react/compiler-runtime";
//#region src/extensions/appUpdateMount.tsx
/**
* App-mount that surfaces "a new version is available" as a persistent
* toast with a Reload action. Pairs with the dot + actionable row on the
* status chip (src/plugins/system-status) — the toast is the loud,
* dismissible nudge; the chip is the quiet, always-there fallback once the
* toast is gone.
*
* We never reload on our own (see src/registerServiceWorker.ts): the new
* build is already active in the background, so Reload — or any manual
* reload — lands on it. The toast uses `duration: Infinity` so it waits for
* the user instead of auto-dismissing, and a stable id so repeated SW
* detections never stack.
*
* Distinct from the `update-indicator` plugin, which flags per-block
* content edited by another user — this one is about the app build itself.
*/
var UPDATE_TOAST_ID = "app-update-available";
var AppUpdatePrompt = () => {
	const $ = c(3);
	const available = useAppUpdateAvailable();
	let t0;
	let t1;
	if ($[0] !== available) {
		t0 = () => {
			if (!available) return;
			showInfo("A new version is available.", {
				id: UPDATE_TOAST_ID,
				duration: Number.POSITIVE_INFINITY,
				action: {
					label: "Reload",
					onClick: _temp
				}
			});
			return _temp2;
		};
		t1 = [available];
		$[0] = available;
		$[1] = t0;
		$[2] = t1;
	} else {
		t0 = $[1];
		t1 = $[2];
	}
	useEffect(t0, t1);
	return null;
};
var appUpdatePromptExtension = systemToggle({
	id: "system:app-update-prompt",
	name: "App update prompt",
	description: "Surfaces a newer app build as a reload prompt — a toast plus a quiet indicator in the status chip."
}).of([
	appMountsFacet.of({
		id: "core.app-update-prompt",
		component: AppUpdatePrompt
	}, { source: "core" }),
	appUpdateDiagnosticContribution,
	appReloadActionContribution
]);
function _temp() {
	return appUpdate.reload();
}
function _temp2() {
	return dismissToast(UPDATE_TOAST_ID);
}
//#endregion
export { appUpdatePromptExtension };

//# sourceMappingURL=appUpdateMount.js.map