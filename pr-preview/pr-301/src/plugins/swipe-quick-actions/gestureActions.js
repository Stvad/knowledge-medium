import { ActionContextTypes } from "../../shortcuts/types.js";
import { GESTURE_PROGRESS_CANCEL_EVENT } from "../../shortcuts/gestureAction.js";
import { SWIPE_QUICK_ACTION_OPEN_EVENT, dispatchSwipeQuickActionMenuEvent, dispatchSwipeQuickActionProgressEvent } from "./events.js";
//#region src/plugins/swipe-quick-actions/gestureActions.ts
/**
* `swipe-left` PROGRESS: stream the live toolbar-reveal. Receives the
* recognizer's tick (a CustomEvent carrying `dx`) on each move and the
* synthesized settle trigger on a non-committing release — bridged to the menu's
* progress event as `active` / `cancel`.
*/
var swipeLeftRevealAction = {
	id: "swipe-quick-actions.reveal",
	description: "Swipe left: reveal the quick-action toolbar",
	context: ActionContextTypes.BLOCK_POINTER,
	gestureBinding: {
		gesture: "swipe-left",
		phase: "progress"
	},
	handler: ({ block, targetElement, renderScopeId }, trigger) => {
		const event = trigger;
		const settling = event.type === GESTURE_PROGRESS_CANCEL_EVENT;
		const dx = settling ? 0 : event.detail.dx;
		dispatchSwipeQuickActionProgressEvent(targetElement, block.id, dx, settling ? "cancel" : "active", renderScopeId);
	}
};
/** `swipe-left` COMMIT: open the quick-action menu for the swiped block. */
var swipeLeftOpenAction = {
	id: "swipe-quick-actions.open",
	description: "Swipe left: open the quick-action menu",
	context: ActionContextTypes.BLOCK_POINTER,
	gestureBinding: { gesture: "swipe-left" },
	handler: ({ block, targetElement, renderScopeId }) => {
		dispatchSwipeQuickActionMenuEvent(targetElement, SWIPE_QUICK_ACTION_OPEN_EVENT, block.id, renderScopeId);
	}
};
/**
* `swipe-right` COMMIT: close an open quick-action menu. The todo plugin also
* binds `swipe-right` (cycle a todo); both are candidates in the same
* run-until-handled gesture. Two mechanisms make "close wins when a menu is
* open, else the todo cycles" hold regardless of which plugins are enabled:
*  - ORDER — this action's `block-pointer` context is priority `high`, so it's
*    resolved BEFORE the todo cycle's `normal-mode` candidate (which would
*    otherwise win the recency tiebreak, since block-pointer is never "active").
*  - DECLINE — the CLOSE event is `cancelable` and the menu calls
*    `preventDefault` only when a menu for this block was actually open, so
*    `dispatchEvent` returns false (a menu closed → handled, return void) when
*    one was and true otherwise (none open → return false to DECLINE, letting
*    the loop fall through to the todo cycle).
* Net: a right-swipe closes the menu when one is open and cycles a todo when not
* — and disabling Todo still leaves the close affordance intact.
*/
var swipeRightCloseAction = {
	id: "swipe-quick-actions.close",
	description: "Swipe right: close the quick-action menu",
	context: ActionContextTypes.BLOCK_POINTER,
	gestureBinding: { gesture: "swipe-right" },
	handler: ({ block, targetElement, renderScopeId }) => {
		if (dispatchSwipeQuickActionMenuEvent(targetElement, "swipe-quick-actions:close", block.id, renderScopeId)) return false;
	}
};
var swipeGestureActions = [
	swipeLeftRevealAction,
	swipeLeftOpenAction,
	swipeRightCloseAction
];
//#endregion
export { swipeGestureActions, swipeLeftOpenAction, swipeLeftRevealAction, swipeRightCloseAction };

//# sourceMappingURL=gestureActions.js.map