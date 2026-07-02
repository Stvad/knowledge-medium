import { showError } from "../utils/toast.js";
import { runActionById } from "../shortcuts/runAction.js";
//#region src/extensions/extensionLoadErrorToast.ts
/**
* Surfaces an extension load failure (compile error, malformed default
* export, missing/renamed import) to the user as a toast. Previously these
* only hit `console.error` in the loader, so a broken extension silently
* dropped out of the runtime with no visible signal. The toast carries an
* action that jumps to Extensions settings, where the broken block shows a
* status icon and can be disabled or edited.
*
* Deduped per `key` (the caller keys by `${workspaceId}:${blockId}`) via a
* `seen` set the caller owns: the app runtime re-resolves on every
* extension toggle / `refreshAppRuntime`, and a persistently-broken block
* re-reports its error on each resolution. Without the guard the toast
* would re-fire every time — most annoyingly while the user is in settings
* trying to fix it. Returns whether a toast was shown (false = suppressed
* duplicate), so callers/tests can observe the dedupe.
*/
var OPEN_EXTENSIONS_SETTINGS_ACTION_ID = "open_extensions_settings";
var toastExtensionLoadError = (seen, key, blockId, error) => {
	if (seen.has(key)) return false;
	seen.add(key);
	showError(`An extension failed to load: ${error.message}`, {
		id: `extension-load-error:${blockId}`,
		duration: 8e3,
		action: {
			label: "Extensions",
			onClick: openExtensionsSettings
		}
	});
	return true;
};
var openExtensionsSettings = () => {
	try {
		Promise.resolve(runActionById(OPEN_EXTENSIONS_SETTINGS_ACTION_ID, new CustomEvent("extension-load-error"))).catch((error) => console.error("Failed to open Extensions settings from load-error toast", error));
	} catch (error) {
		console.error("Failed to open Extensions settings from load-error toast", error);
	}
};
//#endregion
export { toastExtensionLoadError };

//# sourceMappingURL=extensionLoadErrorToast.js.map