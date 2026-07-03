//#region src/shortcuts/gestureAction.ts
var dispatcher = null;
/** Installed by <HotkeyReconciler/> on mount; torn down on unmount so stray
*  callers fail soft (no gesture action) rather than against a stale runtime. */
var setGestureActionDispatcher = (next) => {
	dispatcher = next;
};
/** Module-level entry point so non-React callers (recognizers, escape-hatch
*  surfaces) can dispatch a gesture without threading the runtime. No-op
*  returning false before the coordinator mounts. */
var dispatchGesture = (gesture, suppliedDeps, event) => dispatcher ? dispatcher(gesture, suppliedDeps, event) : false;
/** Event type a progress action receives on its `cancel()` — the gesture ended
*  without committing. A progress action distinguishes a settle from an active
*  tick by `event.type === GESTURE_PROGRESS_CANCEL_EVENT`; active ticks carry the
*  recognizer's own event type + payload. */
var GESTURE_PROGRESS_CANCEL_EVENT = "gesture-progress-cancel";
/** Build the synthesized trigger delivered to a progress action when its gesture
*  is cancelled (released before threshold / reversed / `pointercancel`). */
var gestureProgressCancelEvent = (gesture) => new CustomEvent(GESTURE_PROGRESS_CANCEL_EVENT, { detail: { gesture } });
var progressDispatcher = null;
/** Installed alongside the commit dispatcher by <HotkeyReconciler/>. */
var setGestureProgressDispatcher = (next) => {
	progressDispatcher = next;
};
/** Module-level entry point mirroring {@link dispatchGesture}. No-op returning
*  null before the coordinator mounts. */
var beginGestureProgress = (gesture, suppliedDeps) => progressDispatcher ? progressDispatcher(gesture, suppliedDeps) : null;
//#endregion
export { GESTURE_PROGRESS_CANCEL_EVENT, beginGestureProgress, dispatchGesture, gestureProgressCancelEvent, setGestureActionDispatcher, setGestureProgressDispatcher };

//# sourceMappingURL=gestureAction.js.map