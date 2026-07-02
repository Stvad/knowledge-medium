import { createToggleStore } from "../../utils/toggleStore.js";
//#region src/plugins/find-replace/toggleStore.ts
/** Open/closed state for the find-replace dialog. The mounted
*  `FindReplaceDialog` reads it via `useSyncExternalStore`; the action
*  and header button flip it. External callers reach it through
*  `runActionById(FIND_REPLACE_ACTION_ID)`. */
var findReplaceToggle = createToggleStore("find-replace");
//#endregion
export { findReplaceToggle };

//# sourceMappingURL=toggleStore.js.map