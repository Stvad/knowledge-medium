import { CREATE_NODE_IN_ACTIVE_PANEL_ACTION_ID } from "../../shortcuts/defaultShortcuts.js";
import { COMMAND_PALETTE_ACTION_ID } from "../command-palette/context.js";
import "../command-palette/index.js";
import { APPEND_TODAY_DAILY_BLOCK_ACTION_ID, OPEN_TODAY_ACTION_ID } from "../daily-notes/actions.js";
import "../daily-notes/index.js";
import { QUICK_FIND_ACTION_ID } from "../quick-find/index.js";
import { OPEN_LEFT_SIDEBAR_ACTION_ID } from "../left-sidebar/actions.js";
import "../left-sidebar/index.js";
//#region src/plugins/mobile-bottom-nav/defaultItems.ts
var openSidebarBottomNavItem = {
	id: "mobile-bottom-nav.open-sidebar",
	actionId: OPEN_LEFT_SIDEBAR_ACTION_ID
};
var newNodeBottomNavItem = {
	id: "mobile-bottom-nav.new-node",
	actionId: CREATE_NODE_IN_ACTIVE_PANEL_ACTION_ID
};
var appendTodayDailyBlockBottomNavItem = {
	id: "mobile-bottom-nav.append-today-daily-block",
	actionId: APPEND_TODAY_DAILY_BLOCK_ACTION_ID
};
var todayBottomNavItem = {
	id: "mobile-bottom-nav.today",
	actionId: OPEN_TODAY_ACTION_ID
};
var searchBottomNavItem = {
	id: "mobile-bottom-nav.search",
	actionId: QUICK_FIND_ACTION_ID
};
var commandPaletteBottomNavItem = {
	id: "mobile-bottom-nav.command-palette",
	actionId: COMMAND_PALETTE_ACTION_ID
};
var undoBottomNavItem = {
	id: "mobile-bottom-nav.undo",
	actionId: "undo"
};
//#endregion
export { appendTodayDailyBlockBottomNavItem, commandPaletteBottomNavItem, newNodeBottomNavItem, openSidebarBottomNavItem, searchBottomNavItem, todayBottomNavItem, undoBottomNavItem };

//# sourceMappingURL=defaultItems.js.map