//#region src/plugins/daily-notes/dateScrubGesture.ts
/** Pixels of scrub motion per ISO day. Picked so that ±2 weeks fits
*  inside half a thumb-arc on a phone (~200px = 14 days). */
var PIXELS_PER_DAY = 14;
var WHEEL_LINE_PX = 16;
/** Caps so a wild horizontal swing across the screen doesn't put the
*  date a year out by accident. The user can still tap the calendar
*  chips in the swipe-menu Reschedule sheet for big jumps. */
var MAX_OFFSET_DAYS = 90;
var MIN_OFFSET_DAYS = -90;
var activeHandler = null;
var registerScrubHandler = (handler) => {
	activeHandler = handler;
	return () => {
		if (activeHandler === handler) activeHandler = null;
	};
};
var keyboardScrub = null;
var computeDeltaDays = (offsetPx) => {
	const raw = Math.round(offsetPx / PIXELS_PER_DAY);
	if (raw > MAX_OFFSET_DAYS) return MAX_OFFSET_DAYS;
	if (raw < MIN_OFFSET_DAYS) return MIN_OFFSET_DAYS;
	return raw;
};
/**
* Touch-scrub entry points used by the date-scrub RECOGNIZER
* (`dateScrubRecognizer.ts`). The continuous-gesture loop drives the touch path
* now (replacing the bespoke content surface), but it still talks to the same
* registered `ScrubHandler` (the overlay) the keyboard/wheel path does — these
* thin wrappers keep `activeHandler` encapsulated. `start` returns whether the
* overlay accepted (block is date-shiftable). */
var startTouchScrub = (args) => activeHandler?.start(args) ?? false;
var updateTouchScrub = (deltaDays, intentCancel) => {
	activeHandler?.update(deltaDays, intentCancel);
};
var endTouchScrub = (commit) => {
	activeHandler?.end(commit);
};
/** Named gestures the date-scrub recognizer (`dateScrubRecognizer.ts`) emits for
*  actions (`dateScrubGestureActions.ts`) to bind: `date-scrub` carries the live
*  PROGRESS preview, `date-scrub-commit` the COMMIT on a committing release.
*  `DATE_SCRUB_GESTURE` doubles as the recognizer's arbitration id. */
var DATE_SCRUB_GESTURE = "date-scrub";
var DATE_SCRUB_COMMIT_GESTURE = "date-scrub-commit";
/** Event type the recognizer streams on each progress tick. The terminal settle
*  arrives as the dispatcher's `GESTURE_PROGRESS_CANCEL_EVENT` instead. */
var DATE_SCRUB_PROGRESS_TICK_EVENT = "date-scrub-progress-tick";
var dateScrubProgressTickEvent = (detail) => new CustomEvent(DATE_SCRUB_PROGRESS_TICK_EVENT, { detail });
var finishKeyboardScrub = (commit) => {
	if (!keyboardScrub) return;
	keyboardScrub = null;
	activeHandler?.end(commit);
};
/** Exposed to the `DATE_SCRUB_CONTEXT` commit/cancel actions. Idempotent
*  — calling when no scrub is active is a no-op. */
var endKeyboardScrub = finishKeyboardScrub;
var normalizeWheelDelta = (event) => {
	const multiplier = event.deltaMode === 1 ? WHEEL_LINE_PX : event.deltaMode === 2 ? typeof window === "undefined" ? 800 : window.innerWidth : 1;
	return {
		dx: event.deltaX * multiplier,
		dy: event.deltaY * multiplier
	};
};
var scrubPixelsForWheelDelta = (event) => {
	const { dx, dy } = normalizeWheelDelta(event);
	return -(dy !== 0 ? dy : dx);
};
var escapeCssIdent = (value) => {
	if (typeof CSS !== "undefined" && typeof CSS.escape === "function") return CSS.escape(value);
	return value.replace(/[^a-zA-Z0-9_-]/g, "\\$&");
};
var keyboardScrubAnchorPoint = (blockId) => {
	const fallback = {
		x: typeof window === "undefined" ? 0 : window.innerWidth / 2,
		y: typeof window === "undefined" ? 0 : window.innerHeight / 2
	};
	if (typeof document === "undefined") return fallback;
	const selector = `[data-block-id="${escapeCssIdent(blockId)}"]`;
	const activeElement = document.activeElement;
	const blockElement = (activeElement instanceof Element ? activeElement.closest(selector) : null) ?? document.querySelector(selector);
	const anchor = blockElement?.querySelector(".block-content") ?? blockElement;
	if (!anchor) return fallback;
	const rect = anchor.getBoundingClientRect();
	if (rect.width === 0 && rect.height === 0) return fallback;
	return {
		x: rect.left + rect.width / 2,
		y: rect.top + rect.height / 2
	};
};
var keyboardScrubTotalDays = (scrub) => clampDeltaDays(scrub.keyDeltaDays + computeDeltaDays(scrub.wheelPx));
var clampDeltaDays = (deltaDays) => {
	if (deltaDays > MAX_OFFSET_DAYS) return MAX_OFFSET_DAYS;
	if (deltaDays < MIN_OFFSET_DAYS) return MIN_OFFSET_DAYS;
	return deltaDays;
};
var startKeyboardScrub = (target) => {
	if (keyboardScrub) return keyboardScrub;
	if (!activeHandler) return null;
	const point = keyboardScrubAnchorPoint(target.block.id);
	if (!activeHandler.start({
		block: target.block,
		blockId: target.block.id,
		adapter: target.adapter,
		startX: point.x,
		startY: point.y
	})) return null;
	const next = {
		blockId: target.block.id,
		keyDeltaDays: 0,
		wheelPx: 0
	};
	keyboardScrub = next;
	return next;
};
/** Exposed for the `DATE_SCRUB_CONTEXT` enter action: starts a keyboard
*  scrub on `target` if the overlay accepts (block is date-shiftable).
*  Returns true on success — the action handler then activates the
*  modal context. */
var startKeyboardScrubForTarget = (target) => startKeyboardScrub(target) !== null;
/** Exposed for the `DATE_SCRUB_CONTEXT` movement actions: applies a day
*  delta to the running scrub. No-op if no scrub is active (the modal
*  context's invariant should prevent this, but the action handlers
*  can't atomically observe it). */
var applyKeyboardScrubDelta = (deltaDays) => {
	if (!keyboardScrub) return;
	keyboardScrub.keyDeltaDays = clampDeltaDays(keyboardScrub.keyDeltaDays + deltaDays);
	activeHandler?.update(keyboardScrubTotalDays(keyboardScrub), false);
};
var stageDateScrubDraft = (blockId, draft) => activeHandler?.stage?.(blockId, draft) ?? false;
var getDateScrubDraft = (blockId) => activeHandler?.getDraft?.(blockId) ?? null;
var updateKeyboardScrubByWheel = (scrub, event) => {
	const deltaPx = scrubPixelsForWheelDelta(event);
	if (deltaPx === 0) return;
	event.preventDefault();
	event.stopPropagation();
	scrub.wheelPx += deltaPx;
	activeHandler?.update(keyboardScrubTotalDays(scrub), false);
};
/** Window listeners the keyboard-scrub state machine needs that don't
*  fit the action system: wheel events as a feeder while a scrub is
*  already armed (no wheel-trigger primitive on the action substrate),
*  and window blur to cancel.
*
*  Activation, movement, commit, and cancel are all routed through
*  `DATE_SCRUB_CONTEXT` actions (see dateScrubActions.ts). The wheel
*  here is purely a feeder — it never starts a scrub on its own, only
*  contributes deltas while one is armed via hold-`s`. */
var installDateScrubAuxListeners = () => {
	if (typeof window === "undefined") return () => void 0;
	const handleBlur = () => {
		finishKeyboardScrub(false);
	};
	const handleWheel = (event) => {
		if (!keyboardScrub) return;
		updateKeyboardScrubByWheel(keyboardScrub, event);
	};
	window.addEventListener("blur", handleBlur);
	window.addEventListener("wheel", handleWheel, {
		capture: true,
		passive: false
	});
	return () => {
		window.removeEventListener("blur", handleBlur);
		window.removeEventListener("wheel", handleWheel, true);
		finishKeyboardScrub(false);
	};
};
//#endregion
export { DATE_SCRUB_COMMIT_GESTURE, DATE_SCRUB_GESTURE, DATE_SCRUB_PROGRESS_TICK_EVENT, applyKeyboardScrubDelta, computeDeltaDays, dateScrubProgressTickEvent, endKeyboardScrub, endTouchScrub, getDateScrubDraft, installDateScrubAuxListeners, registerScrubHandler, stageDateScrubDraft, startKeyboardScrubForTarget, startTouchScrub, updateTouchScrub };

//# sourceMappingURL=dateScrubGesture.js.map