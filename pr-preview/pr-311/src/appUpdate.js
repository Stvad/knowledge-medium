import { useSyncExternalStore } from "react";
//#region src/appUpdate.ts
/**
* "A newer build has been installed and is ready — reload to use it."
*
* Set by registerServiceWorker when the service worker reports an update;
* read by the reload prompt (toast) and the status chip. We never
* reload the page on our own. The new service worker is activated in the
* background (see registerServiceWorker), so the new build is served on the
* *next* load whether the user clicks our Reload prompt or just reloads the
* tab themselves — a single reload, not two.
*/
var available = false;
var listeners = /* @__PURE__ */ new Set();
var isAvailable = () => available;
var subscribe = (listener) => {
	listeners.add(listener);
	return () => listeners.delete(listener);
};
var appUpdate = {
	isAvailable,
	subscribe,
	/** Mark a newer build as ready. Idempotent — only the first call notifies,
	*  so repeated SW detections don't re-fire the prompt. */
	markAvailable() {
		if (available) return;
		available = true;
		for (const listener of listeners) listener();
	},
	/** Reload onto the new build. The new SW already controls the page (it was
	*  activated in the background), so a plain reload is served fresh. */
	reload() {
		if (typeof window !== "undefined") window.location.reload();
	}
};
/** Reactive read of {@link appUpdate.isAvailable} for components (toast,
*  status chip). */
var useAppUpdateAvailable = () => {
	return useSyncExternalStore(subscribe, isAvailable, _temp);
};
function _temp() {
	return false;
}
//#endregion
export { appUpdate, useAppUpdateAvailable };

//# sourceMappingURL=appUpdate.js.map