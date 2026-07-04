import { systemToggle } from "../../facets/togglable.js";
import { actionsFacet, panelMountsFacet } from "../../extensions/core.js";
import { continuousGestureRecognizersFacet } from "../../extensions/continuousGestures.js";
import { DEFAULT_QUICK_ACTION_ITEMS, SWIPE_RIGHT_BLOCK_ACTION_ID, quickActionItemsFacet } from "./actions.js";
import { SWIPE_QUICK_ACTIONS_GESTURE_ID, swipeRecognizer } from "./swipeRecognizer.js";
import { SwipeActionMenu } from "./SwipeActionMenu.js";
import { swipeGestureActions } from "./gestureActions.js";
//#region src/plugins/swipe-quick-actions/index.ts
var swipeActionMenuPanelMount = {
	id: "swipe-quick-actions.panel-menu",
	component: SwipeActionMenu
};
var swipeQuickActionsPlugin = systemToggle({
	id: "system:swipe-quick-actions",
	name: "Swipe quick actions",
	description: "Swipe gesture on a block to reveal a quick-action menu."
}).of([
	continuousGestureRecognizersFacet.of(swipeRecognizer, { source: "swipe-quick-actions" }),
	swipeGestureActions.map((action) => actionsFacet.of(action, { source: "swipe-quick-actions" })),
	DEFAULT_QUICK_ACTION_ITEMS.map((item) => quickActionItemsFacet.of(item, { source: "swipe-quick-actions" })),
	panelMountsFacet.of(swipeActionMenuPanelMount, { source: "swipe-quick-actions" })
]);
//#endregion
export { SWIPE_QUICK_ACTIONS_GESTURE_ID, SWIPE_RIGHT_BLOCK_ACTION_ID, SwipeActionMenu, quickActionItemsFacet, swipeQuickActionsPlugin };

//# sourceMappingURL=index.js.map