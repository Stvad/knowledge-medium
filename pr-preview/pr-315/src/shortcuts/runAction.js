import { actionContextsFacet } from "../extensions/core.js";
import { useAppRuntime } from "../extensions/runtimeContext.js";
import { useActiveContextsDispatch, useActiveContextsState } from "./ActiveContexts.js";
import { resolveDeps } from "./resolve.js";
import { getActiveActionById, getEffectiveActions } from "./effectiveActions.js";
import { invokeAction } from "./actionDispatch.js";
import { c } from "react/compiler-runtime";
//#region src/shortcuts/runAction.ts
/**
* Shared by-id dispatch body behind both the React `useRunAction` hook and
* the module-level `runActionById` dispatcher <HotkeyReconciler/> installs.
* Resolves the active action, validates its context is live, runs the
* handler, and coerces away the sync not-handled sentinel (imperative
* callers have no candidate list to fall through to). The two call sites
* differ only in whether `ctx` is built from hook values or reconciler
* refs — keeping the body here stops them from drifting.
*/
function dispatchActiveActionById(ctx, actionId, trigger) {
	const { runtime, active, contextConfigsByType, dispatch } = ctx;
	const action = getActiveActionById(getEffectiveActions(runtime), {
		active,
		contextConfigsByType
	}, actionId);
	if (!action) throw new Error(`[runActionById] Active action with ID "${actionId}" not found.`);
	const deps = resolveDeps(action, active, contextConfigsByType);
	if (!deps) throw new Error(`[runActionById] Context "${action.context}" is not active.`);
	const result = invokeAction(runtime, {
		action,
		deps,
		trigger,
		dispatch
	});
	return result === false ? void 0 : result;
}
/** Build the `(type → config)` lookup the by-id dispatch path needs from a
*  resolved runtime's `actionContextsFacet` contributions. */
var contextConfigsByTypeFrom = (runtime) => new Map(runtime.read(actionContextsFacet).map((c) => [c.type, c]));
var dispatcher = null;
/**
* Installed by <HotkeyReconciler/> on mount. Keeps the module-level
* `runActionById` in sync with the current FacetRuntime and active contexts.
*
* NOTE: this is the "module-global mirror installed from React" pattern.
* `processorRejectionToast` now reads `repo.facetRuntime` directly instead
* (no mirror); converging this onto that pattern is deferred to the
* runtime-composition work — but note the deliberate teardown-to-null on
* unmount here (so stray callers fail soft against a stale runtime) is a
* lifecycle that a plain `repo.facetRuntime` read would NOT reproduce.
*/
function setRunActionDispatcher(next) {
	dispatcher = next;
}
/**
* Run an action by ID from anywhere — including outside React (e.g. from
* evaluated code in useAgentRuntimeBridge or one-off imperative callsites).
*
* Throws if called before the app mounts <HotkeyReconciler/>.
*
* NOTE: unlike the keyboard / pointer / supplied-deps dispatch paths, this does
* NOT consult `canDispatch` — it resolves the active action by id and invokes
* the handler. Callers own the precondition: an action whose handler trusts its
* deps (e.g. an SRS-only action) must either be unreachable here when
* inapplicable (the command palette filters by `isVisible`) or guard inside its
* handler. `dispatchActionWithDeps` below DOES gate on `canDispatch`. The single
* `invokeAction` choke (now shared by both paths) is the natural place to unify
* these gates, but doing so would change imperative-dispatch semantics app-wide
* (`runActionById` would start respecting `canDispatch`); deferred to the broader
* dispatch-lifecycle work.
*/
var runActionById = (actionId, trigger) => {
	if (!dispatcher) throw new Error("[runActionById] Dispatcher not installed. Is <HotkeyReconciler/> mounted?");
	return dispatcher(actionId, trigger);
};
var withDepsDispatcher = null;
/**
* Installed by <HotkeyReconciler/> on mount; torn down on unmount so stray
* callers fail soft (no dispatch) rather than against a stale runtime.
*/
function setActionWithDepsDispatcher(next) {
	withDepsDispatcher = next;
}
/**
* Run a known action by id with caller-SUPPLIED deps, through the same
* `resolve` + run-until-handled path the keyboard and pointer coordinators
* use. Unlike `runActionById`, the action's context need NOT be keyboard-active
* — the caller (the swipe gesture, a quick-action menu button) holds the deps,
* and the gesture is itself the activation. The supplied deps are validated at
* the dispatch boundary (`resolveDeps`); a declining `canDispatch` or a synchronous
* `false` return falls through like any other candidate.
*
* Returns true when a candidate handled (or threw), false when none matched or
* every candidate declined — so the caller can fall back to a default. No-op
* returning false before the coordinator mounts.
*/
var dispatchActionWithDeps = (actionId, deps, trigger) => withDepsDispatcher ? withDepsDispatcher(actionId, deps, trigger) : false;
/**
* Hook variant for React callers. Re-computes on runtime/activeContexts changes
* so consumers re-render when the action's availability changes.
*/
function useRunAction() {
	const $ = c(4);
	const runtime = useAppRuntime();
	const active = useActiveContextsState();
	const dispatch = useActiveContextsDispatch();
	let t0;
	if ($[0] !== active || $[1] !== dispatch || $[2] !== runtime) {
		t0 = (actionId, trigger) => dispatchActiveActionById({
			runtime,
			active,
			contextConfigsByType: contextConfigsByTypeFrom(runtime),
			dispatch
		}, actionId, trigger);
		$[0] = active;
		$[1] = dispatch;
		$[2] = runtime;
		$[3] = t0;
	} else t0 = $[3];
	return t0;
}
//#endregion
export { contextConfigsByTypeFrom, dispatchActionWithDeps, dispatchActiveActionById, runActionById, setActionWithDepsDispatcher, setRunActionDispatcher, useRunAction };

//# sourceMappingURL=runAction.js.map