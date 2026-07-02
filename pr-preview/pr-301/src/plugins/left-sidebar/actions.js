import { Menu } from "../../../node_modules/lucide-react/dist/esm/icons/menu.js";
import { ActionContextTypes } from "../../shortcuts/types.js";
import { leftSidebarToggle } from "./toggleStore.js";
//#region src/plugins/left-sidebar/actions.ts
var OPEN_LEFT_SIDEBAR_ACTION_ID = "open_left_sidebar";
var openLeftSidebarAction = {
	id: OPEN_LEFT_SIDEBAR_ACTION_ID,
	description: "Open sidebar",
	context: ActionContextTypes.GLOBAL,
	icon: Menu,
	handler: () => {
		leftSidebarToggle.open();
	}
};
var leftSidebarActions = [openLeftSidebarAction];
//#endregion
export { OPEN_LEFT_SIDEBAR_ACTION_ID, leftSidebarActions, openLeftSidebarAction };

//# sourceMappingURL=actions.js.map