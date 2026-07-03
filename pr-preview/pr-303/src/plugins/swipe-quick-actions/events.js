//#region src/plugins/swipe-quick-actions/events.ts
var SWIPE_QUICK_ACTION_OPEN_EVENT = "swipe-quick-actions:open";
var SWIPE_QUICK_ACTION_CLOSE_EVENT = "swipe-quick-actions:close";
var SWIPE_QUICK_ACTION_RUN_EVENT = "swipe-quick-actions:run";
var SWIPE_QUICK_ACTION_PROGRESS_EVENT = "swipe-quick-actions:progress";
/** The streamed progress TICK the recognizer hands to its `progress`-phase
*  action as the trigger (in-memory, NOT dispatched to the DOM). The action
*  reads `dx` and bridges to the menu via {@link dispatchSwipeQuickActionProgressEvent}.
*  Separate from SWIPE_QUICK_ACTION_PROGRESS_EVENT, which is the action→menu
*  DOM event. */
var SWIPE_QUICK_ACTION_PROGRESS_TICK_EVENT = "swipe-quick-actions:progress-tick";
var swipeProgressTickEvent = (dx) => new CustomEvent(SWIPE_QUICK_ACTION_PROGRESS_TICK_EVENT, { detail: { dx } });
var isSwipeQuickActionMenuEvent = (event) => {
	if (!(event instanceof CustomEvent) || typeof event.detail !== "object" || event.detail === null) return false;
	const detail = event.detail;
	return typeof detail.blockId === "string" && (detail.renderScopeId === void 0 || typeof detail.renderScopeId === "string");
};
var isSwipeQuickActionRunEvent = (event) => isSwipeQuickActionMenuEvent(event) && typeof event.detail.actionId === "string";
var isSwipeQuickActionProgressEvent = (event) => isSwipeQuickActionMenuEvent(event) && typeof event.detail.dx === "number" && typeof event.detail.phase === "string";
var dispatchSwipeQuickActionMenuEvent = (target, type, blockId, renderScopeId) => target.dispatchEvent(new CustomEvent(type, {
	bubbles: true,
	cancelable: true,
	detail: renderScopeId ? {
		blockId,
		renderScopeId
	} : { blockId }
}));
var dispatchSwipeQuickActionRunEvent = (target, actionId, blockId, renderScopeId) => target.dispatchEvent(new CustomEvent(SWIPE_QUICK_ACTION_RUN_EVENT, {
	bubbles: true,
	cancelable: true,
	detail: renderScopeId ? {
		blockId,
		renderScopeId,
		actionId
	} : {
		blockId,
		actionId
	}
}));
var dispatchSwipeQuickActionProgressEvent = (target, blockId, dx, phase, renderScopeId) => target.dispatchEvent(new CustomEvent(SWIPE_QUICK_ACTION_PROGRESS_EVENT, {
	bubbles: true,
	cancelable: true,
	detail: renderScopeId ? {
		blockId,
		renderScopeId,
		dx,
		phase
	} : {
		blockId,
		dx,
		phase
	}
}));
//#endregion
export { SWIPE_QUICK_ACTION_CLOSE_EVENT, SWIPE_QUICK_ACTION_OPEN_EVENT, SWIPE_QUICK_ACTION_PROGRESS_EVENT, SWIPE_QUICK_ACTION_PROGRESS_TICK_EVENT, SWIPE_QUICK_ACTION_RUN_EVENT, dispatchSwipeQuickActionMenuEvent, dispatchSwipeQuickActionProgressEvent, dispatchSwipeQuickActionRunEvent, isSwipeQuickActionMenuEvent, isSwipeQuickActionProgressEvent, isSwipeQuickActionRunEvent, swipeProgressTickEvent };

//# sourceMappingURL=events.js.map