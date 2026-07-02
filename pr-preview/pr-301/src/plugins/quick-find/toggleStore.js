import { createToggleStore } from "../../utils/toggleStore.js";
//#region src/plugins/quick-find/toggleStore.ts
/** Open/closed state for the quick-find dialog. The mounted `QuickFind`
*  surface reads it via `useSyncExternalStore`; the action and header
*  button flip it. External callers reach it through
*  `runActionById(QUICK_FIND_ACTION_ID)`. */
var quickFindToggle = createToggleStore("quick-find");
//#endregion
export { quickFindToggle };

//# sourceMappingURL=toggleStore.js.map