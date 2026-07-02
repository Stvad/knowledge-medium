import { useAppRuntime } from "../extensions/runtimeContext.js";
import { useActiveContextsDispatch, useActiveContextsState } from "./ActiveContexts.js";
import { gestureProgressCancelEvent, setGestureActionDispatcher, setGestureProgressDispatcher } from "./gestureAction.js";
import { createKeybindingsHandler, matchKeybindingPress, parseKeybinding } from "../../node_modules/tinykeys/dist/tinykeys.js";
import { keybindingOverridesFacet } from "./keybindingOverrides.js";
import { computeInstallableContexts, resolve, resolveDeps } from "./resolve.js";
import { actionRuntimeKey, getEffectiveActions } from "./effectiveActions.js";
import { invokeAction } from "./actionDispatch.js";
import { contextConfigsByTypeFrom, dispatchActiveActionById, setActionWithDepsDispatcher, setRunActionDispatcher } from "./runAction.js";
import { matchesMouseEvent, pointerBindingDescriptor } from "./canonicalizeChord.js";
import { setPointerActionDispatcher } from "./pointerAction.js";
import { gestureBindingDescriptor, matchesGestureEvent } from "./gestureBinding.js";
import { hasEditableTarget, isTypingKeyEvent, withRecoveredLetterKey } from "./utils.js";
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
//#region src/shortcuts/HotkeyReconciler.tsx
var normalizeKeys = (keys) => Array.isArray(keys) ? keys : [keys];
var defaultEventFilter = (event) => !(isTypingKeyEvent(event) && hasEditableTarget(event));
var getInstallableContextDeps = (action, active, contextConfigsByType) => {
	if (!computeInstallableContexts(active, contextConfigsByType).has(action.context)) return null;
	return resolveDeps(action, active, contextConfigsByType);
};
/**
* Run the same event-filter cascade tinykeys' default `ignore` would do,
* but extended with per-context eventFilter overrides. An active context's
* filter returning true means "I want this event even though it'd
* normally be ignored" (e.g. property-editing needs Escape from inside
* an <input>). Otherwise we apply the editable-target heuristic.
*/
var shouldHandleEvent = (event, active, contextConfigsByType) => {
	for (const type of active.keys()) if (contextConfigsByType.get(type)?.eventFilter?.(event)) return true;
	return defaultEventFilter(event);
};
/**
* Keeps `tinykeys` in sync with the facet runtime's declared actions and the
* currently-active contexts from `<ActiveContextsProvider>`.
*
* - Each enabled action gets its own `tinykeys(window, {...})` subscription
*   so per-action install/uninstall is just calling the returned
*   unsubscribe. Many small listeners > one big map: avoids tearing
*   everything down whenever a single context activates.
* - When the action set identity changes (runtime regeneration) every
*   subscription is torn down first; handlers close over the old action
*   objects and would otherwise become stale.
* - When active contexts change, subscriptions are added/removed per
*   action based on whether the action's context is active and installable
*   (modal stacking). Handlers read deps via refs so intra-context
*   dependency changes (e.g. new focused block) don't require rebinding.
* - Per-context eventFilter overrides run inside each handler — tinykeys'
*   built-in `ignore` is bypassed (`() => false`) so we can layer our
*   own filter cascade.
*
* NOTE: an earlier pass replaced the latest-ref pattern below with
* `useEffectEvent`. That broke shortcut delivery in the browser (likely
* because tinykeys fires its handlers from a global keydown listener,
* not a React-tracked event handler — outside that scope the
* effect-event indirection doesn't see the latest closure reliably).
* Reverted to the ref pattern; the refs are written in a useLayoutEffect
* so we don't trip the new react-hooks/refs rule.
*/
function HotkeyReconciler() {
	const runtime = useAppRuntime();
	const active = useActiveContextsState();
	const dispatch = useActiveContextsDispatch();
	const [overridesGeneration, setOverridesGeneration] = useState(0);
	useEffect(() => {
		return runtime.onFacetChange(keybindingOverridesFacet.id, () => {
			setOverridesGeneration((g) => g + 1);
		});
	}, [runtime]);
	const actions = useMemo(() => getEffectiveActions(runtime), [runtime, overridesGeneration]);
	const contextConfigsByType = useMemo(() => contextConfigsByTypeFrom(runtime), [runtime]);
	const activeRef = useRef(active);
	const contextConfigsByTypeRef = useRef(contextConfigsByType);
	const dispatchRef = useRef(dispatch);
	const runtimeRef = useRef(runtime);
	useLayoutEffect(() => {
		activeRef.current = active;
		contextConfigsByTypeRef.current = contextConfigsByType;
		dispatchRef.current = dispatch;
		runtimeRef.current = runtime;
	}, [
		active,
		contextConfigsByType,
		dispatch,
		runtime
	]);
	useEffect(() => {
		setRunActionDispatcher((actionId, trigger) => dispatchActiveActionById({
			runtime,
			active: activeRef.current,
			contextConfigsByType: contextConfigsByTypeRef.current,
			dispatch: dispatchRef.current
		}, actionId, trigger));
		return () => setRunActionDispatcher(null);
	}, [runtime]);
	useEffect(() => {
		setActionWithDepsDispatcher((actionId, supplied, trigger) => {
			const active = activeRef.current;
			const contextConfigsByType = contextConfigsByTypeRef.current;
			return runOrderedCandidates(resolve(getEffectiveActions(runtime), {
				active,
				contextConfigsByType
			}, {
				kind: "supplied",
				actionId
			}), trigger, {
				runtime,
				active,
				contextConfigsByType,
				dispatch: dispatchRef.current
			}, supplied, () => void 0);
		});
		return () => setActionWithDepsDispatcher(null);
	}, [runtime]);
	useEffect(() => {
		setPointerActionDispatcher((event, supplied) => {
			const active = activeRef.current;
			const contextConfigsByType = contextConfigsByTypeRef.current;
			const phase = isTouchGesture(event) ? "tap" : phaseOfPointerEvent(event);
			const eventLike = mouseEventLikeOf(event);
			const matched = getEffectiveActions(runtime).filter((action) => {
				const spec = action.pointerBinding;
				if (!spec) return false;
				const contextFilter = contextConfigsByType.get(action.context)?.pointerTargetFilter;
				if (contextFilter && !contextFilter(event)) return false;
				return (Array.isArray(spec) ? spec : [spec]).some((candidate) => {
					const descriptor = pointerBindingDescriptor(candidate);
					if (descriptor.phase !== phase) return false;
					if (descriptor.kind === "touch") return true;
					if (!eventLike) return false;
					if (!matchesMouseEvent(descriptor, eventLike)) return false;
					if (descriptor.role && !pointerRoleMatches(supplied.targetElement, descriptor.role)) return false;
					return true;
				});
			});
			if (matched.length === 0) return false;
			return runOrderedCandidates(resolve(matched, {
				active,
				contextConfigsByType
			}, { kind: "pointer" }), event, {
				runtime,
				active,
				contextConfigsByType,
				dispatch: dispatchRef.current
			}, supplied, (action) => applyTriggerEventOptions(event, action, contextConfigsByType));
		});
		return () => setPointerActionDispatcher(null);
	}, [runtime]);
	useEffect(() => {
		setGestureActionDispatcher((gesture, supplied, event) => {
			const active = activeRef.current;
			const contextConfigsByType = contextConfigsByTypeRef.current;
			const matched = getEffectiveActions(runtime).filter((action) => {
				const spec = action.gestureBinding;
				if (!spec) return false;
				return (Array.isArray(spec) ? spec : [spec]).some((candidate) => matchesGestureEvent(gestureBindingDescriptor(candidate), {
					gesture,
					phase: "commit"
				}));
			});
			if (matched.length === 0) return false;
			return runOrderedCandidates(resolve(matched, {
				active,
				contextConfigsByType
			}, { kind: "gesture" }), event, {
				runtime,
				active,
				contextConfigsByType,
				dispatch: dispatchRef.current
			}, supplied, (action) => applyTriggerEventOptions(event, action, contextConfigsByType));
		});
		return () => setGestureActionDispatcher(null);
	}, [runtime]);
	useEffect(() => {
		setGestureProgressDispatcher((gesture, supplied) => {
			const active = activeRef.current;
			const contextConfigsByType = contextConfigsByTypeRef.current;
			const matched = getEffectiveActions(runtime).filter((action) => {
				const spec = action.gestureBinding;
				if (!spec) return false;
				return (Array.isArray(spec) ? spec : [spec]).some((candidate) => matchesGestureEvent(gestureBindingDescriptor(candidate), {
					gesture,
					phase: "progress"
				}));
			});
			if (matched.length === 0) return null;
			const ordered = resolve(matched, {
				active,
				contextConfigsByType
			}, { kind: "gesture" });
			for (const action of ordered) {
				const deps = resolveDeps(action, active, contextConfigsByType, supplied);
				if (!deps) continue;
				if (action.canDispatch && !action.canDispatch(deps)) continue;
				const runProgress = (event) => {
					let result;
					try {
						result = invokeAction(runtime, {
							action,
							deps,
							trigger: event,
							dispatch: dispatchRef.current
						});
					} catch (error) {
						console.error(`[HotkeyReconciler] Progress action ${action.id} threw`, error);
						return;
					}
					Promise.resolve(result).catch((error) => {
						console.error(`[HotkeyReconciler] Progress action ${action.id} rejected`, error);
					});
				};
				return {
					update: (event) => runProgress(event),
					settle: () => runProgress(gestureProgressCancelEvent(gesture))
				};
			}
			return null;
		});
		return () => setGestureProgressDispatcher(null);
	}, [runtime]);
	const installedRef = useRef({
		actions: [],
		keyboard: /* @__PURE__ */ new Map(),
		hold: /* @__PURE__ */ new Map()
	});
	const completedRef = useRef([]);
	useEffect(() => {
		const state = installedRef.current;
		const uninstallHold = (actionKey) => {
			const entry = state.hold.get(actionKey);
			if (!entry) return;
			entry.unsubscribe();
			state.hold.delete(actionKey);
		};
		if (state.actions !== actions) {
			for (const actionKey of Array.from(state.hold.keys())) uninstallHold(actionKey);
			state.keyboard.clear();
			state.actions = actions;
		}
		const desiredActionIds = /* @__PURE__ */ new Set();
		const installable = computeInstallableContexts(active, contextConfigsByType);
		for (const action of actions) {
			if (!action.defaultBinding) continue;
			if (!active.has(action.context)) continue;
			if (!installable.has(action.context)) continue;
			const actionKey = actionRuntimeKey(action);
			desiredActionIds.add(actionKey);
			const binding = action.defaultBinding;
			if (binding.phase === "hold") {
				if (state.hold.has(actionKey)) continue;
				const unsubscribe = installHoldBinding({
					action,
					binding,
					keys: normalizeKeys(binding.keys),
					holdMs: binding.holdMs,
					activeRef,
					contextConfigsByTypeRef,
					dispatchRef,
					runtimeRef
				});
				state.hold.set(actionKey, { unsubscribe });
				continue;
			}
			if (state.keyboard.has(actionKey)) continue;
			state.keyboard.set(actionKey, {
				action,
				binding,
				phase: binding.phase ?? "keydown",
				matcher: makeMatcher(action, binding, completedRef)
			});
		}
		for (const actionKey of Array.from(state.keyboard.keys())) if (!desiredActionIds.has(actionKey)) state.keyboard.delete(actionKey);
		for (const actionKey of Array.from(state.hold.keys())) if (!desiredActionIds.has(actionKey)) uninstallHold(actionKey);
	}, [
		actions,
		active,
		contextConfigsByType
	]);
	useEffect(() => {
		const dispatchPhase = (phase, rawEvent) => {
			const event = withRecoveredLetterKey(rawEvent);
			const completed = completedRef.current;
			completed.length = 0;
			for (const candidate of installedRef.current.keyboard.values()) if (candidate.phase === phase) candidate.matcher(event);
			if (completed.length === 0) return;
			const active = activeRef.current;
			const contextConfigsByType = contextConfigsByTypeRef.current;
			if (!shouldHandleEvent(event, active, contextConfigsByType)) return;
			const bindings = new Map(completed.map((c) => [c.action, c.binding]));
			runOrderedCandidates(resolve([...bindings.keys()], {
				active,
				contextConfigsByType
			}, { kind: "keyboard" }), event, {
				runtime: runtimeRef.current,
				active,
				contextConfigsByType,
				dispatch: dispatchRef.current
			}, void 0, (action) => applyEventOptions(event, action, bindings.get(action), contextConfigsByType));
		};
		const onKeydown = (event) => dispatchPhase("keydown", event);
		const onKeyup = (event) => dispatchPhase("keyup", event);
		window.addEventListener("keydown", onKeydown);
		window.addEventListener("keyup", onKeyup);
		return () => {
			window.removeEventListener("keydown", onKeydown);
			window.removeEventListener("keyup", onKeyup);
		};
	}, []);
	useEffect(() => {
		const state = installedRef.current;
		return () => {
			for (const [, entry] of state.hold) entry.unsubscribe();
			state.hold.clear();
			state.keyboard.clear();
			state.actions = [];
		};
	}, []);
	return null;
}
/**
* Companion observer for `phase: 'hold'` bindings — tinykeys is purely
* event-driven and has no notion of duration.
*
* Lifecycle per armed hold:
*  - On a matching keydown (chord parsed via tinykeys' `matchKeybindingPress`,
*    so `'$mod+s'` etc. work the same as elsewhere), filter the event
*    through the existing context-aware filter (so typing into an input
*    doesn't arm a hold) AND check the binding's context is still
*    eligible. If both pass, preventDefault the keydown (suppresses OS
*    press-and-hold popups on Mac), start a timer for `holdMs`, and
*    remember the chord's primary `event.key` to match the eventual keyup.
*  - OS-driven `event.repeat` keydowns while the key is still held are
*    ignored — we treat the press as already armed. preventDefault is
*    still applied so the input event doesn't reach editable targets.
*  - On keyup of the same primary key before the timer fires, cancel.
*  - On `blur` of the window, cancel.
*  - On timer fire, dispatch via `invokeAction(runtime, {action, deps,
*    trigger: originalKeydown, dispatch})` after re-validating the context is
*    still active. Same path as the keydown / keyup makeHandler uses minus the
*    preventDefault (already done at arm time).
*
* Limitation: if the chord includes modifiers (e.g. `'$mod+s'`) and the
* user releases the modifier but keeps the primary key pressed, the timer
* still fires. Acceptable for the initial date-scrub usage which holds a
* bare letter. Tighten if a future caller needs modifier-release-cancels.
*
* Sequence chords (`'g g'`) are rejected at install time — a "hold a
* sequence" doesn't have well-defined semantics here.
*/
var installHoldBinding = (config) => {
	const { action, binding, keys, holdMs, activeRef, contextConfigsByTypeRef, dispatchRef, runtimeRef } = config;
	const parsed = [];
	for (const rawKey of keys) {
		const presses = parseKeybinding(rawKey);
		if (presses.length !== 1) {
			console.warn(`[HotkeyReconciler] Hold binding "${rawKey}" on action "${action.id}" is a sequence chord; skipped (hold semantics are single-press only).`);
			continue;
		}
		parsed.push({
			rawKey,
			presses
		});
	}
	if (parsed.length === 0) return () => void 0;
	let pending = null;
	const cancel = () => {
		if (!pending) return;
		clearTimeout(pending.timer);
		pending = null;
	};
	const fire = (originalEvent) => {
		const deps = getInstallableContextDeps(action, activeRef.current, contextConfigsByTypeRef.current);
		if (!deps) return;
		if (action.canDispatch && !action.canDispatch(deps)) return;
		try {
			Promise.resolve(invokeAction(runtimeRef.current, {
				action,
				deps,
				trigger: originalEvent,
				dispatch: dispatchRef.current
			})).catch((error) => {
				console.error(`[HotkeyReconciler] Action ${action.id} rejected`, error);
			});
		} catch (error) {
			console.error(`[HotkeyReconciler] Action ${action.id} threw`, error);
		}
	};
	const onKeydown = (rawEvent) => {
		const event = withRecoveredLetterKey(rawEvent);
		if (event.repeat) {
			if (pending) applyEventOptions(event, action, binding, contextConfigsByTypeRef.current);
			return;
		}
		if (pending) return;
		if (!parsed.some(({ presses }) => presses.every((press) => matchKeybindingPress(event, press)))) return;
		const active = activeRef.current;
		const contextConfigsByType = contextConfigsByTypeRef.current;
		if (!getInstallableContextDeps(action, active, contextConfigsByType)) return;
		if (!shouldHandleEvent(event, active, contextConfigsByType)) return;
		applyEventOptions(event, action, binding, contextConfigsByType);
		pending = {
			timer: setTimeout(() => {
				pending = null;
				fire(event);
			}, holdMs),
			primaryKey: event.key
		};
	};
	const onKeyup = (rawEvent) => {
		if (!pending) return;
		if (rawEvent.key !== pending.primaryKey) return;
		cancel();
	};
	const onBlur = () => cancel();
	window.addEventListener("keydown", onKeydown);
	window.addEventListener("keyup", onKeyup);
	window.addEventListener("blur", onBlur);
	return () => {
		window.removeEventListener("keydown", onKeydown);
		window.removeEventListener("keyup", onKeyup);
		window.removeEventListener("blur", onBlur);
		cancel();
	};
};
/**
* Run an ordered candidate list best-first and dispatch the first that handles
* — the single run-until-handled loop shared by the keyboard and pointer
* paths. The three fall-through conditions are treated identically: deps don't
* resolve, `canDispatch` returns false, or the handler synchronously returns
* the not-handled sentinel (`false`).
*
* Event options apply only to the candidate that actually handles (or throws);
* a declining handler leaves the event untouched so the next candidate, or the
* native default, proceeds. NOTE this is a deliberate timing change from the
* pre-Option-D keyboard loop, which applied options BEFORE invoking the
* handler: here they're applied AFTER the synchronous return, because "handled"
* isn't known until the handler returns non-`false`. `preventDefault` is
* unaffected (the UA evaluates the default after the whole sync dispatch), but
* `stopPropagation` now fires after the handler body rather than before. No
* in-tree binding sets `stopPropagation: true`, so this is currently latent;
* a binding that does and relies on propagation already being stopped while its
* handler runs would see the new ordering.
*
* `supplied` deps are merged in for callers that hold them (pointer gestures,
* swipe) and undefined for keyboard. Returns true if a candidate handled (or
* threw), false if every candidate fell through.
*/
var runOrderedCandidates = (ordered, trigger, { runtime, active, contextConfigsByType, dispatch }, supplied, applyOptions) => {
	for (const action of ordered) {
		const deps = resolveDeps(action, active, contextConfigsByType, supplied);
		if (!deps) continue;
		if (action.canDispatch && !action.canDispatch(deps)) continue;
		let result;
		try {
			result = invokeAction(runtime, {
				action,
				deps,
				trigger,
				dispatch
			});
		} catch (error) {
			console.error(`[HotkeyReconciler] Action ${action.id} threw`, error);
			applyOptions(action);
			return true;
		}
		if (result === false) continue;
		applyOptions(action);
		Promise.resolve(result).catch((error) => {
			console.error(`[HotkeyReconciler] Action ${action.id} rejected`, error);
		});
		return true;
	}
	return false;
};
/** A touch gesture carries `changedTouches`; a mouse event does not — the
*  discriminator the dispatcher uses to pick the tap path over the mouse path. */
var isTouchGesture = (event) => "changedTouches" in event;
/** The mouse fields a {@link MouseChordDescriptor} matches against, or null for
*  a touch gesture (a tap has no button/detail/modifiers). */
var mouseEventLikeOf = (event) => isTouchGesture(event) ? null : {
	button: event.button,
	detail: event.detail,
	shiftKey: event.shiftKey,
	altKey: event.altKey,
	ctrlKey: event.ctrlKey,
	metaKey: event.metaKey
};
/** Map a React mouse event to the binding phase it can satisfy. `click` is
*  the default; `pointerdown` lets a double-click beat native text selection. */
var phaseOfPointerEvent = (event) => {
	switch (event.type) {
		case "mousedown":
		case "pointerdown": return "pointerdown";
		case "mouseup":
		case "pointerup": return "pointerup";
		default: return "click";
	}
};
/** A bound node satisfies a descriptor's `role` when it (or an ancestor)
*  carries the matching `data-pointer-role`. */
var pointerRoleMatches = (target, role) => Boolean(target.closest(`[data-pointer-role="${role}"]`));
/** preventDefault / stopPropagation for a handled pointer OR gesture-commit
*  action — one body, since both want the same thing. Block selection wants
*  native text-selection suppressed and the trailing synthesized click kept out
*  of edit-mode, so the defaults are `{preventDefault: true, stopPropagation:
*  true}`; a context overrides via `defaultEventOptions`. Typed on the broad
*  `ActionTrigger` so it serves the pointer path (a React Mouse/Touch event —
*  `PointerGestureEvent` is a subset) and the gesture commit (the native
*  `PointerEvent` that ended the drag, or a synthetic `CustomEvent`) alike; all
*  expose preventDefault/stopPropagation. Eating the commit event is what
*  suppresses the trailing touchend click that today's swipe/scrub
*  `event.preventDefault()` does by hand. Keyboard's `applyEventOptions` stays
*  separate — different defaults (no stopPropagation) and binding-level
*  precedence. */
var applyTriggerEventOptions = (event, action, contextConfigsByType) => {
	const options = {
		preventDefault: true,
		stopPropagation: true,
		...contextConfigsByType.get(action.context)?.defaultEventOptions
	};
	if (options.stopPropagation) event.stopPropagation();
	if (options.preventDefault) event.preventDefault();
};
/**
* preventDefault / stopPropagation per the same precedence the keydown /
* keyup handler uses (binding > context-default > built-in default). Pulled
* out so the hold companion can reuse it for both the arming keydown and
* any OS-repeat keydowns that follow before the timer fires.
*/
var applyEventOptions = (event, action, binding, contextConfigsByType) => {
	const options = {
		preventDefault: true,
		stopPropagation: false,
		...contextConfigsByType.get(action.context)?.defaultEventOptions,
		...binding.eventOptions
	};
	if (options.stopPropagation) event.stopPropagation();
	if (options.preventDefault) event.preventDefault();
};
/**
* Build a candidate's tinykeys matcher. Every key in the binding maps to the
* same callback, which records the candidate in `completedRef` for the event
* in flight instead of running the handler — the coordinator orders the
* recorded candidates and runs the winner.
*
* `createKeybindingsHandler` (rather than `tinykeys()` directly) lets the
* coordinator preprocess each event with `withRecoveredLetterKey` before the
* matcher sees it: tinykeys reads event.key, which Mac option-transforms
* (Alt+y → '¥') and Linux compose setups corrupt for letter chords; the
* wrapper restores the logical letter from event.keyCode, and works on
* Colemak/Dvorak where event.code lies about layout. `ignore: () => false`
* disables tinykeys' built-in editable-target filter — the coordinator runs
* the context-aware cascade (`shouldHandleEvent`) itself, so contexts like
* property-editing can opt into events tinykeys would otherwise drop.
*/
var makeMatcher = (action, binding, completedRef) => {
	const record = () => {
		completedRef.current.push({
			action,
			binding
		});
	};
	const bindingMap = {};
	for (const key of normalizeKeys(binding.keys)) bindingMap[key] = record;
	return createKeybindingsHandler(bindingMap, { ignore: () => false });
};
//#endregion
export { HotkeyReconciler };

//# sourceMappingURL=HotkeyReconciler.js.map