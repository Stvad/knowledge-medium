import { createToggleStore } from "../../utils/toggleStore.js";
//#region src/plugins/left-sidebar/toggleStore.ts
/** Open/closed state for the left sidebar. The mounted `LeftSidebar`
*  reads it via `useSyncExternalStore`; the open action, header button,
*  and in-sidebar navigation flip it. External callers reach it through
*  `runActionById(OPEN_LEFT_SIDEBAR_ACTION_ID)`. */
var leftSidebarToggle = createToggleStore("left-sidebar");
//#endregion
export { leftSidebarToggle };

//# sourceMappingURL=toggleStore.js.map