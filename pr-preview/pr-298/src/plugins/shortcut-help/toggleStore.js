import { createToggleStore } from "../../utils/toggleStore.js";
//#region src/plugins/shortcut-help/toggleStore.ts
/** Open/closed state for the shortcut-help overlay. The mounted
*  `ShortcutHelpOverlay` reads it via `useSyncExternalStore`; the global
*  `shortcut_help` action flips it. External callers reach it through
*  `runActionById(SHORTCUT_HELP_ACTION_ID)`, never by importing this store. */
var shortcutHelpToggle = createToggleStore("shortcut-help");
//#endregion
export { shortcutHelpToggle };

//# sourceMappingURL=toggleStore.js.map