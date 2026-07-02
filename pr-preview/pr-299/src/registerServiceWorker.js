import { appUpdate } from "./appUpdate.js";
//#region src/registerServiceWorker.ts
/**
* Registers the PWA service worker once per page load.
*
* Only runs in production builds — leaving HMR untouched in dev. The SW
* file is served from the app's base URL (so it works under any
* APP_BASE_PATH).
*
* Update behaviour (see also src/appUpdate.ts):
*  - When a new SW reaches `installed` while an old one still controls the
*    page, we flag the update. The SW self-`skipWaiting()`s in its own
*    install handler (public/sw.js), so it activates in the background on
*    its own — the `SKIP_WAITING` postMessage below is only a fallback for
*    a worker that somehow didn't. We do NOT reload the page. The point is
*    that the *next* load — whether the user clicks the Reload prompt or
*    just reloads the tab on their own — is served by the new build in a
*    single reload, instead of the new SW sitting "waiting" until every tab
*    closes (which is why a plain reload used to keep serving the old build).
*  - We then flag `appUpdate.markAvailable()` so the toast + status
*    chip can offer a deliberate "Reload" without surprising the user.
*  - Long-lived PWA tabs may never navigate, so the browser's implicit
*    update check never fires. We poll `registration.update()` on an
*    interval and when the tab regains focus / the device reconnects, so a
*    deploy is noticed while the app is open rather than only on cold start.
*
* Registers immediately rather than on `load` so the SW can install as
* early as possible and intercept the tail of the first-visit module
* graph; the standard "wait for load" pattern would push registration
* past the initial fetch storm and miss them all.
*/
var UPDATE_POLL_INTERVAL_MS = 1800 * 1e3;
var registerServiceWorker = () => {
	if (typeof window === "undefined") return;
	if (!("serviceWorker" in navigator)) return;
	navigator.serviceWorker.register(`/knowledge-medium/pr-preview/pr-299/sw.js`, { scope: "/knowledge-medium/pr-preview/pr-299/" }).then((registration) => {
		const onInstalled = (worker) => {
			if (!worker || worker.state !== "installed") return;
			if (!navigator.serviceWorker.controller) return;
			worker.postMessage("SKIP_WAITING");
			appUpdate.markAvailable();
		};
		onInstalled(registration.waiting);
		registration.addEventListener("updatefound", () => {
			const next = registration.installing;
			if (!next) return;
			next.addEventListener("statechange", () => onInstalled(next));
		});
		const checkForUpdate = () => {
			registration.update().catch(() => {});
		};
		setInterval(checkForUpdate, UPDATE_POLL_INTERVAL_MS);
		document.addEventListener("visibilitychange", () => {
			if (document.visibilityState === "visible") checkForUpdate();
		});
		window.addEventListener("online", checkForUpdate);
	}).catch((err) => {
		console.warn("[sw] registration failed", err);
	});
};
//#endregion
export { registerServiceWorker };

//# sourceMappingURL=registerServiceWorker.js.map