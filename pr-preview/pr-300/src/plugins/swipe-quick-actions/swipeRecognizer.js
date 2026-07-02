import { isEditingProp, isFocusedBlock } from "../../data/properties.js";
import { isInteractiveContentEvent } from "../../extensions/blockInteraction.js";
import { GESTURE_CANCEL, GESTURE_IDLE } from "../../extensions/continuousGestures.js";
import { swipeProgressTickEvent } from "./events.js";
//#region src/plugins/swipe-quick-actions/swipeRecognizer.ts
/** Arbitration key (also the recognizer id). */
var SWIPE_QUICK_ACTIONS_GESTURE_ID = "swipe-quick-actions";
/** Min horizontal travel before a release commits open/run. */
var SWIPE_TRIGGER_PX = 50;
/** Once travel exceeds this AND |dx| > |dy|, lock to horizontal. */
var DIRECTION_LOCK_PX = 8;
/** The menu is mobile-only (SwipeActionMenu early-returns otherwise), so the
*  recognizer applies the same gate at gesture time — read live so a resize
*  doesn't leave a stale decision (the factory isn't re-run on resize). */
var MOBILE_BREAKPOINT_QUERY = "(max-width: 767px)";
var isMobileViewport = () => typeof window !== "undefined" && typeof window.matchMedia === "function" && window.matchMedia(MOBILE_BREAKPOINT_QUERY).matches;
var isBlockEditing = (blockId, uiStateBlock, renderScopeId) => isFocusedBlock(uiStateBlock, blockId, renderScopeId) && Boolean(uiStateBlock.peekProperty(isEditingProp));
/** Links and video can occupy a large part of readable content; a tap on them
*  still works (only a completed horizontal swipe preventDefaults), so they are
*  NOT treated as interactive-content the way buttons/editor are. */
var isSwipeSurfaceEvent = (target) => {
	if (typeof Node === "undefined" || !(target instanceof Node)) return false;
	const element = target.nodeType === Node.ELEMENT_NODE ? target : target.parentElement;
	return Boolean(element?.closest("a[href],video"));
};
/**
* Build the swiped block's deps. `BlockPointerDependencies` (block + the surface
* element + render scope) so the gesture-bound actions can dispatch the menu's
* DOM events on `targetElement` and run with the right block.
*/
var dependenciesFor = (context, ctx) => {
	const renderScopeId = typeof context.blockContext?.renderScopeId === "string" ? context.blockContext.renderScopeId : void 0;
	return {
		block: context.block,
		uiStateBlock: context.uiStateBlock,
		scopeRootId: context.scopeRootId,
		scopeRootForcesOpen: !context.blockContext?.isNestedSurface,
		targetElement: ctx.element,
		...renderScopeId ? { renderScopeId } : {}
	};
};
var swipeRecognizer = (context) => {
	const { block, uiStateBlock } = context;
	const renderScopeId = typeof context.blockContext?.renderScopeId === "string" ? context.blockContext.renderScopeId : void 0;
	let start = null;
	const editing = () => isBlockEditing(block.id, uiStateBlock, renderScopeId);
	return {
		id: SWIPE_QUICK_ACTIONS_GESTURE_ID,
		isEnabled: () => isMobileViewport() && !editing(),
		touchAction: "pan-y",
		onPointerDown(session, ctx) {
			if (ctx.event.pointerType !== "touch") return GESTURE_IDLE;
			if (session.pointers.length > 1) {
				start = null;
				return GESTURE_CANCEL;
			}
			if (!isSwipeSurfaceEvent(ctx.event.target) && isInteractiveContentEvent(ctx.event)) return GESTURE_IDLE;
			start = {
				x: session.changed.x,
				y: session.changed.y,
				pointerId: session.changed.pointerId,
				decided: null,
				previewed: false
			};
			return GESTURE_IDLE;
		},
		onPointerMove(session, ctx) {
			if (!start) return GESTURE_IDLE;
			if (session.pointers.length > 1) {
				start = null;
				return GESTURE_CANCEL;
			}
			if (session.changed.pointerId !== start.pointerId) return GESTURE_IDLE;
			const dx = session.changed.x - start.x;
			const dy = session.changed.y - start.y;
			if (start.decided === null && (Math.abs(dx) >= DIRECTION_LOCK_PX || Math.abs(dy) >= DIRECTION_LOCK_PX)) start.decided = Math.abs(dx) > Math.abs(dy) ? "horizontal" : "vertical";
			if (start.decided === "vertical") {
				start = null;
				return GESTURE_CANCEL;
			}
			if (start.decided !== "horizontal") return GESTURE_IDLE;
			if (dx < 0) {
				start.previewed = true;
				return {
					status: "progress",
					gesture: "swipe-left",
					deps: dependenciesFor(context, ctx),
					event: swipeProgressTickEvent(dx)
				};
			}
			return { status: "active" };
		},
		onPointerUp(session, ctx) {
			if (!start) return GESTURE_IDLE;
			if (session.changed.pointerId !== start.pointerId) return GESTURE_IDLE;
			const dx = session.changed.x - start.x;
			const dy = session.changed.y - start.y;
			start = null;
			if (Math.abs(dx) > Math.abs(dy)) {
				if (dx <= -50) return {
					status: "commit",
					gesture: "swipe-left",
					deps: dependenciesFor(context, ctx)
				};
				if (dx >= 50) return {
					status: "commit",
					gesture: "swipe-right",
					deps: dependenciesFor(context, ctx)
				};
			}
			return GESTURE_CANCEL;
		},
		onPointerCancel() {
			start = null;
		}
	};
};
//#endregion
export { SWIPE_QUICK_ACTIONS_GESTURE_ID, SWIPE_TRIGGER_PX, swipeRecognizer };

//# sourceMappingURL=swipeRecognizer.js.map