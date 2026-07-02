import { isEditingProp, isFocusedBlock } from "../../data/properties.js";
import { isInteractiveContentEvent } from "../../extensions/blockInteraction.js";
import { GESTURE_CANCEL, GESTURE_IDLE } from "../../extensions/continuousGestures.js";
import { pickBlockDateAdapter } from "./blockDateAdapter.js";
import { DATE_SCRUB_COMMIT_GESTURE, DATE_SCRUB_GESTURE, computeDeltaDays, dateScrubProgressTickEvent } from "./dateScrubGesture.js";
//#region src/plugins/daily-notes/dateScrubRecognizer.ts
/** Arbitration key (also the recognizer id); equals the PROGRESS gesture name. */
var DATE_SCRUB_GESTURE_ID = DATE_SCRUB_GESTURE;
var MOBILE_BREAKPOINT_QUERY = "(max-width: 767px)";
var isMobileViewport = () => typeof window !== "undefined" && typeof window.matchMedia === "function" && window.matchMedia(MOBILE_BREAKPOINT_QUERY).matches;
/** Midpoint horizontal travel that distinguishes a deliberate scrub from a
*  pinch (midpoint ~stationary) or a two-finger vertical scroll (dy dominates). */
var HORIZONTAL_LOCK_PX = 10;
/** Vertical midpoint travel past which an active scrub reads as "cancel". */
var VERTICAL_CANCEL_PX = 60;
var isBlockEditing = (blockId, uiStateBlock, renderScopeId) => isFocusedBlock(uiStateBlock, blockId, renderScopeId) && Boolean(uiStateBlock.peekProperty(isEditingProp));
/** Links / video are allowed (a two-finger gesture there is still ours); buttons
*  and the editor keep their own touch handling. Mirrors the swipe recognizer. */
var isScrubSurfaceEvent = (target) => {
	if (typeof Node === "undefined" || !(target instanceof Node)) return false;
	const element = target.nodeType === Node.ELEMENT_NODE ? target : target.parentElement;
	return Boolean(element?.closest("a[href],video"));
};
var midpointOf = (a, b) => ({
	x: (a.x + b.x) / 2,
	y: (a.y + b.y) / 2
});
var dateScrubRecognizer = (context) => {
	const { block, uiStateBlock } = context;
	const renderScopeId = typeof context.blockContext?.renderScopeId === "string" ? context.blockContext.renderScopeId : void 0;
	let anchor = null;
	let scrubbing = false;
	const editing = () => isBlockEditing(block.id, uiStateBlock, renderScopeId);
	const isTouch = (ctx) => ctx.event.pointerType === "touch";
	const isEligibleSurface = (target) => isScrubSurfaceEvent(target) || !isInteractiveContentEvent({ target });
	const depsFor = (ctx) => ({
		block,
		uiStateBlock,
		scopeRootId: context.scopeRootId,
		scopeRootForcesOpen: !context.blockContext?.isNestedSurface,
		targetElement: ctx.element,
		...renderScopeId ? { renderScopeId } : {}
	});
	const progressTick = (dx, dy, ctx, begin) => ({
		status: "progress",
		gesture: DATE_SCRUB_GESTURE,
		deps: depsFor(ctx),
		event: dateScrubProgressTickEvent({
			deltaDays: computeDeltaDays(dx),
			cancelIntent: Math.abs(dy) > VERTICAL_CANCEL_PX,
			...begin ? { begin } : {}
		})
	});
	const lockAnchor = (session) => {
		const [a, b] = session.pointers.filter((p) => isEligibleSurface(p.target));
		if (!a || !b) return;
		const mid = midpointOf(a, b);
		anchor = {
			idA: a.pointerId,
			idB: b.pointerId,
			midX: mid.x,
			midY: mid.y,
			lastMidX: mid.x,
			lastMidY: mid.y
		};
	};
	const trackedPair = (session) => {
		if (!anchor) return null;
		const a = session.pointers.find((p) => p.pointerId === anchor.idA);
		const b = session.pointers.find((p) => p.pointerId === anchor.idB);
		return a && b ? {
			a,
			b
		} : null;
	};
	const onTwoFinger = (session, ctx) => {
		if (!anchor) {
			if (!isTouch(ctx)) return GESTURE_IDLE;
			lockAnchor(session);
		}
		const pair = trackedPair(session);
		if (!pair) return GESTURE_IDLE;
		const mid = midpointOf(pair.a, pair.b);
		anchor.lastMidX = mid.x;
		anchor.lastMidY = mid.y;
		const dx = mid.x - anchor.midX;
		const dy = mid.y - anchor.midY;
		if (!scrubbing) {
			if (Math.abs(dx) <= HORIZONTAL_LOCK_PX || Math.abs(dx) <= Math.abs(dy)) return GESTURE_IDLE;
			const runtime = context.repo.facetRuntime;
			if (!runtime || !pickBlockDateAdapter(runtime, block)) {
				anchor = null;
				return GESTURE_CANCEL;
			}
			scrubbing = true;
			return progressTick(dx, dy, ctx, {
				startX: anchor.midX,
				startY: anchor.midY
			});
		}
		return progressTick(dx, dy, ctx);
	};
	return {
		id: DATE_SCRUB_GESTURE_ID,
		isEnabled: () => isMobileViewport() && !editing(),
		touchAction: "pan-y",
		onPointerDown(session, ctx) {
			if (!isTouch(ctx)) return GESTURE_IDLE;
			if (!anchor && session.pointers.length >= 2) lockAnchor(session);
			return GESTURE_IDLE;
		},
		onPointerMove(session, ctx) {
			if (session.pointers.length < 2) {
				if (!scrubbing) anchor = null;
				return GESTURE_IDLE;
			}
			return onTwoFinger(session, ctx);
		},
		onPointerUp(session, ctx) {
			if (!anchor) return GESTURE_IDLE;
			if (!(session.changed.pointerId === anchor.idA || session.changed.pointerId === anchor.idB)) return GESTURE_IDLE;
			if (!scrubbing) {
				anchor = null;
				return GESTURE_IDLE;
			}
			const cancel = Math.abs(anchor.lastMidY - anchor.midY) > VERTICAL_CANCEL_PX;
			anchor = null;
			scrubbing = false;
			return cancel ? GESTURE_CANCEL : {
				status: "commit",
				gesture: DATE_SCRUB_COMMIT_GESTURE,
				deps: depsFor(ctx)
			};
		},
		onPointerCancel(session) {
			if (!anchor) return GESTURE_IDLE;
			if (session.changed.pointerId !== anchor.idA && session.changed.pointerId !== anchor.idB) return GESTURE_IDLE;
			anchor = null;
			scrubbing = false;
			return GESTURE_CANCEL;
		}
	};
};
//#endregion
export { DATE_SCRUB_GESTURE_ID, dateScrubRecognizer };

//# sourceMappingURL=dateScrubRecognizer.js.map