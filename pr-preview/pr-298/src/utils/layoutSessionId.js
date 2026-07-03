import v4 from "../../node_modules/uuid/dist/v4.js";
//#region src/utils/layoutSessionId.ts
var BROWSER_LAYOUT_SESSION_ID_STORAGE_KEY = "ws-nav.layoutSessionId";
var INSTALLED_APP_LAYOUT_SESSION_ID_STORAGE_KEY = "ws-nav.installedAppLayoutSessionId";
var memoizedLayoutSessionId = null;
var readOrCreateLayoutSessionId = (storage, key, makeId = v4) => {
	const stored = storage.getItem(key);
	if (stored) return stored;
	const generated = makeId();
	storage.setItem(key, generated);
	return generated;
};
var INSTALLED_APP_DISPLAY_MODES = [
	"standalone",
	"minimal-ui",
	"fullscreen",
	"window-controls-overlay"
];
var isInstalledAppDisplayMode = () => {
	if (typeof window === "undefined") return false;
	if (window.navigator.standalone === true) return true;
	if (typeof window.matchMedia !== "function") return false;
	return INSTALLED_APP_DISPLAY_MODES.some((mode) => window.matchMedia(`(display-mode: ${mode})`).matches);
};
var getLayoutSessionStorageTarget = () => {
	if (typeof window === "undefined") return null;
	try {
		if (isInstalledAppDisplayMode()) return {
			storage: window.localStorage,
			key: INSTALLED_APP_LAYOUT_SESSION_ID_STORAGE_KEY
		};
		return {
			storage: window.sessionStorage,
			key: BROWSER_LAYOUT_SESSION_ID_STORAGE_KEY
		};
	} catch {
		return null;
	}
};
var getLayoutSessionId = () => {
	if (memoizedLayoutSessionId) return memoizedLayoutSessionId;
	const target = getLayoutSessionStorageTarget();
	if (!target) {
		memoizedLayoutSessionId = v4();
		return memoizedLayoutSessionId;
	}
	try {
		memoizedLayoutSessionId = readOrCreateLayoutSessionId(target.storage, target.key);
	} catch {
		memoizedLayoutSessionId = v4();
	}
	return memoizedLayoutSessionId;
};
var __resetLayoutSessionIdForTesting = () => {
	memoizedLayoutSessionId = null;
};
//#endregion
export { BROWSER_LAYOUT_SESSION_ID_STORAGE_KEY, INSTALLED_APP_LAYOUT_SESSION_ID_STORAGE_KEY, __resetLayoutSessionIdForTesting, getLayoutSessionId, isInstalledAppDisplayMode, readOrCreateLayoutSessionId };

//# sourceMappingURL=layoutSessionId.js.map