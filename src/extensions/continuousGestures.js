import { defineFacet, isFunction } from "../facets/facet.js";
import { useAppRuntime } from "./runtimeContext.js";
import { beginGestureProgress, dispatchGesture } from "../shortcuts/gestureAction.js";
import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { c } from "react/compiler-runtime";
//#region src/extensions/continuousGestures.ts
/**
* Continuous-gesture recognizer facet + per-block recognition loop.
*
* The core infrastructure that turns a stream of Pointer Events on a block's
* content surface into named gestures dispatched through the action system. A
* recognizer (contributed by core for swipe, by a plugin for date-scrub, …) is
* a state machine that classifies the motion and, at commit, emits a gesture
* NAME + the block's deps; the loop dispatches it via `dispatchGesture`, so the
* recognizer never names the action. See `docs/continuous-gesture-triggers.md`.
*
* This module owns four cross-cutting concerns so recognizers don't each
* re-implement them (the bespoke `swipeGesture.ts` / `dateScrubGesture.ts`
* machinery this replaces did):
*  - the per-block pointer SESSION (which pointers are down, where), built from
*    Pointer Events (mouse/touch/pen unified; `pointerId` pairs an event to its
*    pointer the way the old code tracked `Touch.identifier` by hand);
*  - ARBITRATION — one recognizer at a time owns a block (LAST-ACTIVE-WINS):
*    when one goes `active` the others are evicted (their in-flight state
*    dropped) but stay ELIGIBLE, so a later gesture can take the block over once
*    the owner releases — the 1-finger swipe yields on a 2nd finger and the
*    2-finger scrub then claims. This absorbs `blockGestureConflicts`;
*  - ENABLEMENT — a recognizer's `isEnabled` gate (mobile viewport, not editing,
*    …) is the single source of truth for whether it's applicable here-and-now:
*    the loop skips a disabled recognizer's handlers and drops it from the
*    `touch-action` union, so each recognizer states applicability ONCE instead
*    of re-checking it in every handler. Per-event OWNERSHIP (pointer type,
*    finger count, interactive target) is the separate concern that stays in the
*    handlers;
*  - the non-passive listener + `touch-action` SEAM for scroll suppression.
*
* Recognition that the model can't express stays possible: a plugin can ignore
* this facet, contribute raw `blockContentSurfacePropsFacet` handlers, and reach
* the same trigger via `dispatchGesture` directly (the escape hatch).
*/
/** Allocation-free singletons for the common no-op verdicts. */
var GESTURE_IDLE = { status: "idle" };
var GESTURE_ACTIVE = { status: "active" };
var GESTURE_CANCEL = { status: "cancel" };
var continuousGestureRecognizersFacet = defineFacet({
	id: "core.continuous-gesture-recognizers",
	combine: (contributions) => (context) => {
		const result = [];
		for (const contribution of contributions) {
			const recognizer = contribution(context);
			if (recognizer) result.push(recognizer);
		}
		return result;
	},
	empty: () => () => [],
	validate: isFunction
});
/**
* Combine the `touch-action` values several recognizers require into one the
* surface can carry. `'none'` (gesture owns both axes) is most restrictive and
* dominates; identical values collapse to that value; genuinely DIFFERENT
* requirements can't both be satisfied by a single static property, so we fall
* back to `'none'` (hand everything to JS) — the conservative, correct choice.
* In practice every block gesture today is horizontal and asks for `'pan-y'`.
*/
var unionTouchAction = (values) => {
	const present = values.filter(Boolean);
	if (present.length === 0) return void 0;
	if (present.includes("none")) return "none";
	const unique = [...new Set(present)];
	return unique.length === 1 ? unique[0] : "none";
};
/**
* The `touch-action` a surface should carry right now: the union (see
* `unionTouchAction`) over only the recognizers that are currently ENABLED. A
* disabled recognizer can't fire, so it must not constrain the surface — this is
* what keeps `pan-y` off a block whose gesture is inapplicable (desktop
* viewport, an editing block, …). `isEnabled` is read live, so the React layer
* recomputes this each render as enablement changes.
*/
var enabledTouchAction = (recognizers) => unionTouchAction(recognizers.filter((r) => r.isEnabled?.() ?? true).map((r) => r.touchAction ?? ""));
/**
* The per-block recognition loop, framework-agnostic so it can be driven by
* synthetic samples in tests. Holds the session (active pointers) + arbitration
* state (which recognizer owns the block, which are out) for ONE block — there
* is no cross-block coordination because gestures on different blocks are
* independent, which is exactly why each block mounts its own controller.
*/
var createBlockGestureController = ({ recognizers, element, dispatch = dispatchGesture, beginProgress = beginGestureProgress }) => {
	const pointers = /* @__PURE__ */ new Map();
	let activeId = null;
	const out = /* @__PURE__ */ new Set();
	let progress = null;
	const settleProgress = () => {
		progress?.dispatch?.settle();
		progress = null;
	};
	const resetSession = () => {
		settleProgress();
		activeId = null;
		out.clear();
	};
	const toPointer = (sample) => ({
		pointerId: sample.pointerId,
		x: sample.clientX,
		y: sample.clientY,
		pointerType: sample.pointerType,
		target: sample.target
	});
	const sessionWith = (changed) => ({
		pointers: [...pointers.values()].map((p) => p.pointerId === changed.pointerId ? changed : p),
		changed
	});
	const isEligible = (recognizer) => !out.has(recognizer.id) && (activeId === null || activeId === recognizer.id);
	const enabled = (recognizer) => recognizer.isEnabled?.() ?? true;
	const evictRivals = (keepId, session, ctx) => {
		for (const recognizer of recognizers) {
			if (recognizer.id === keepId || out.has(recognizer.id)) continue;
			recognizer.onPointerCancel?.(session, ctx);
		}
	};
	const claim = (recognizer, session, ctx) => {
		if (activeId === recognizer.id) return;
		activeId = recognizer.id;
		evictRivals(recognizer.id, session, ctx);
	};
	const applyVerdict = (recognizer, verdict, session, ctx) => {
		switch (verdict.status) {
			case "idle": return {
				handled: false,
				prevent: false
			};
			case "active":
				if (progress?.recognizerId === recognizer.id) settleProgress();
				claim(recognizer, session, ctx);
				return {
					handled: false,
					prevent: true
				};
			case "progress":
				claim(recognizer, session, ctx);
				if (!progress || progress.recognizerId !== recognizer.id) progress = {
					recognizerId: recognizer.id,
					dispatch: beginProgress(verdict.gesture, verdict.deps)
				};
				progress.dispatch?.update(verdict.event);
				return {
					handled: false,
					prevent: true
				};
			case "commit": {
				const committed = dispatch(verdict.gesture, verdict.deps, ctx.event);
				if (progress?.recognizerId === recognizer.id) if (committed) progress = null;
				else settleProgress();
				out.add(recognizer.id);
				if (activeId === recognizer.id) activeId = null;
				return {
					handled: true,
					prevent: ctx.event.defaultPrevented
				};
			}
			case "cancel":
				if (progress?.recognizerId === recognizer.id) settleProgress();
				out.add(recognizer.id);
				if (activeId === recognizer.id) activeId = null;
				return {
					handled: false,
					prevent: false
				};
		}
	};
	const releaseDisabledOwner = (session, ctx) => {
		if (activeId === null) return;
		const owner = recognizers.find((r) => r.id === activeId);
		if (!owner || enabled(owner)) return;
		owner.onPointerCancel?.(session, ctx);
		if (progress?.recognizerId === owner.id) settleProgress();
		activeId = null;
	};
	const run = (phase, sample) => {
		const session = sessionWith(toPointer(sample));
		const ctx = {
			element,
			event: sample.event
		};
		releaseDisabledOwner(session, ctx);
		let prevent = false;
		for (const recognizer of recognizers) {
			if (!isEligible(recognizer) || !enabled(recognizer)) continue;
			const { handled, prevent: shouldPrevent } = applyVerdict(recognizer, (phase === "down" ? recognizer.onPointerDown : phase === "move" ? recognizer.onPointerMove : recognizer.onPointerUp)?.call(recognizer, session, ctx) ?? GESTURE_IDLE, session, ctx);
			if (shouldPrevent) prevent = true;
			if (handled) break;
		}
		return prevent;
	};
	return {
		handlePointerDown(sample) {
			pointers.set(sample.pointerId, toPointer(sample));
			return run("down", sample);
		},
		handlePointerMove(sample) {
			if (!pointers.has(sample.pointerId)) return false;
			pointers.set(sample.pointerId, toPointer(sample));
			return run("move", sample);
		},
		handlePointerUp(sample) {
			const prevent = run("up", sample);
			pointers.delete(sample.pointerId);
			if (pointers.size === 0) resetSession();
			return prevent;
		},
		handlePointerCancel(sample) {
			const session = sessionWith(toPointer(sample));
			const ctx = {
				element,
				event: sample.event
			};
			for (const recognizer of recognizers) {
				if (out.has(recognizer.id)) continue;
				const verdict = recognizer.onPointerCancel?.(session, ctx);
				if (verdict) applyVerdict(recognizer, verdict, session, ctx);
			}
			pointers.delete(sample.pointerId);
			if (pointers.size === 0) resetSession();
		},
		get touchAction() {
			return enabledTouchAction(recognizers);
		}
	};
};
var toSample = (event) => ({
	pointerId: event.pointerId,
	clientX: event.clientX,
	clientY: event.clientY,
	pointerType: event.pointerType,
	target: event.target,
	event
});
/**
* Capture the pointer to the surface once a recognizer engages it, so a drag
* that wanders off the block still delivers its terminal `pointerup` /
* `pointercancel` HERE. Touch pointers are implicitly captured to their target
* on `pointerdown`; mouse and pen are NOT — so without this an off-block mouse/
* pen release lands elsewhere, the controller never sees the up, and the block
* stays stranded in an in-flight gesture (later gestures then route only to the
* stale active recognizer). Idempotent per spec, and guarded: jsdom lacks the
* API and the call can throw if the pointer is already gone — both non-fatal.
*/
var capturePointer = (element, pointerId) => {
	try {
		element.setPointerCapture(pointerId);
	} catch {}
};
/** How long a click swallow stays armed waiting for the synthesized click. The
*  click follows `pointerup` within a frame; this generous window only matters
*  as a self-disarm so a gesture that produced NO click can't eat a later real
*  one. */
var SUPPRESS_CLICK_WINDOW_MS = 400;
/**
* Swallow the next `click` on `element` (capture phase, one-shot). Under Pointer
* Events, canceling `pointerup` does NOT suppress the compatibility `click` —
* only canceling `pointerdown` suppresses compat mouse events, and we can't do
* that (a down can't know it will become a committed gesture, and it would also
* kill focus/selection). So after a committed up-gesture we explicitly eat the
* trailing click here, or it lands on the block / an interactive descendant
* after the gesture action already ran. Capture + `stopPropagation` keeps it from
* descendants; `once` disarms on the first click and the timeout disarms if none
* is synthesized (desktop, or a browser that already suppressed it).
*/
var suppressNextClick = (element) => {
	const onClick = (event) => {
		event.preventDefault();
		event.stopPropagation();
	};
	element.addEventListener("click", onClick, {
		capture: true,
		once: true
	});
	setTimeout(() => element.removeEventListener("click", onClick, true), SUPPRESS_CLICK_WINDOW_MS);
};
/**
* Subscribe to viewport changes that can flip a recognizer's `isEnabled`
* (crossing a width breakpoint, an orientation change). Deliberately generic —
* it carries no specific media query, so whatever breakpoint a recognizer reads
* is covered; the `touch-action` snapshot's value-equality (a string) keeps a
* resize that doesn't change enablement from re-rendering. Module-level so its
* identity is stable across renders (a changing `subscribe` would re-subscribe
* every render).
*/
var subscribeViewport = (onChange) => {
	if (typeof window === "undefined") return () => {};
	window.addEventListener("resize", onChange);
	window.addEventListener("orientationchange", onChange);
	return () => {
		window.removeEventListener("resize", onChange);
		window.removeEventListener("orientationchange", onChange);
	};
};
/**
* Wire the per-block recognition loop onto a content-surface element. Attaches
* native Pointer Event listeners (move is non-passive so `preventDefault` works
* as the `touch-action` fallback) and applies the recognizers' union
* `touch-action`. A no-op when no recognizer is contributed, so every block that
* has none pays nothing.
*
* Returns a CALLBACK REF the caller must attach to the content node (instead of
* a plain ref object). The callback bumps a version counter the listener effect
* depends on, so the effect re-runs when the content node is REMOUNTED (e.g.
* `ContentSlot` swaps after a renderer / surface change) while `recognizers` is
* unchanged. A plain ref object's identity never changes, so the effect wouldn't
* re-run and the listeners would stay bound to the now-detached old node,
* silently killing gestures on the new surface. The caller's own `elementRef` is
* still written through, so other consumers of that ref (the shell decorator
* stack, …) keep seeing the node.
*
* `context` MUST be referentially stable across renders — `recognizers` is
* memoized on it, and a new identity each render would rebuild the controller
* mid-drag, dropping in-flight gesture / arbitration / preview state. Callers
* pass a memoized resolve context (the block shell already does).
*/
var useContinuousGestures = (context, elementRef) => {
	const $ = c(22);
	const runtime = useAppRuntime();
	let t0;
	if ($[0] !== runtime) {
		t0 = runtime.read(continuousGestureRecognizersFacet);
		$[0] = runtime;
		$[1] = t0;
	} else t0 = $[1];
	const resolveRecognizers = t0;
	let t1;
	if ($[2] !== context || $[3] !== resolveRecognizers) {
		t1 = resolveRecognizers(context);
		$[2] = context;
		$[3] = resolveRecognizers;
		$[4] = t1;
	} else t1 = $[4];
	const recognizers = t1;
	const nodeRef = useRef(null);
	const [nodeVersion, setNodeVersion] = useState(0);
	let t2;
	if ($[5] !== elementRef) {
		t2 = (node) => {
			elementRef.current = node;
			nodeRef.current = node;
			setNodeVersion(_temp);
		};
		$[5] = elementRef;
		$[6] = t2;
	} else t2 = $[6];
	const setRef = t2;
	let t3;
	if ($[7] !== recognizers) {
		t3 = () => {
			const element = nodeRef.current;
			if (!element || recognizers.length === 0) return;
			const controller = createBlockGestureController({
				recognizers,
				element
			});
			const onDown = (event) => {
				if (controller.handlePointerDown(toSample(event))) event.preventDefault();
			};
			const onMove = (event_0) => {
				if (controller.handlePointerMove(toSample(event_0))) {
					event_0.preventDefault();
					capturePointer(element, event_0.pointerId);
				}
			};
			const onUp = (event_1) => {
				if (controller.handlePointerUp(toSample(event_1))) {
					event_1.preventDefault();
					suppressNextClick(element);
				}
			};
			const onCancel = (event_2) => {
				controller.handlePointerCancel(toSample(event_2));
			};
			element.addEventListener("pointerdown", onDown);
			element.addEventListener("pointermove", onMove, { passive: false });
			element.addEventListener("pointerup", onUp);
			element.addEventListener("pointercancel", onCancel);
			return () => {
				element.removeEventListener("pointerdown", onDown);
				element.removeEventListener("pointermove", onMove);
				element.removeEventListener("pointerup", onUp);
				element.removeEventListener("pointercancel", onCancel);
			};
		};
		$[7] = recognizers;
		$[8] = t3;
	} else t3 = $[8];
	let t4;
	if ($[9] !== nodeVersion || $[10] !== recognizers) {
		t4 = [recognizers, nodeVersion];
		$[9] = nodeVersion;
		$[10] = recognizers;
		$[11] = t4;
	} else t4 = $[11];
	useEffect(t3, t4);
	let t5;
	let t6;
	if ($[12] !== recognizers) {
		t5 = () => enabledTouchAction(recognizers);
		t6 = () => enabledTouchAction(recognizers);
		$[12] = recognizers;
		$[13] = t5;
		$[14] = t6;
	} else {
		t5 = $[13];
		t6 = $[14];
	}
	const desiredTouchAction = useSyncExternalStore(subscribeViewport, t5, t6);
	let t7;
	if ($[15] !== desiredTouchAction || $[16] !== recognizers) {
		t7 = () => {
			const element_0 = nodeRef.current;
			if (!element_0 || recognizers.length === 0) return;
			const previousTouchAction = element_0.style.touchAction;
			if (desiredTouchAction) element_0.style.touchAction = desiredTouchAction;
			return () => {
				element_0.style.touchAction = previousTouchAction;
			};
		};
		$[15] = desiredTouchAction;
		$[16] = recognizers;
		$[17] = t7;
	} else t7 = $[17];
	let t8;
	if ($[18] !== desiredTouchAction || $[19] !== nodeVersion || $[20] !== recognizers) {
		t8 = [
			desiredTouchAction,
			recognizers,
			nodeVersion
		];
		$[18] = desiredTouchAction;
		$[19] = nodeVersion;
		$[20] = recognizers;
		$[21] = t8;
	} else t8 = $[21];
	useEffect(t7, t8);
	return setRef;
};
function _temp(v) {
	return v + 1;
}
//#endregion
export { GESTURE_ACTIVE, GESTURE_CANCEL, GESTURE_IDLE, continuousGestureRecognizersFacet, createBlockGestureController, enabledTouchAction, suppressNextClick, unionTouchAction, useContinuousGestures };

//# sourceMappingURL=continuousGestures.js.map