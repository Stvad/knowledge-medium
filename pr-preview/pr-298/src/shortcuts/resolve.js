import { ActionContextTypes } from "./types.js";
//#region src/shortcuts/resolve.ts
/**
* The resolution core: pure, DOM-free functions that decide which
* action(s) a trigger maps to, best-first. Shared by the keyboard
* coordinator (`HotkeyReconciler`) and the imperative
* `runActionById`/`useRunAction` paths so the two can never diverge on
* precedence — that divergence is the bug this core retires.
*
* `resolve` ORDERS candidates; it does not MATCH chords. Keyboard chord
* matching (including tinykeys sequence state for `g g`) stays in the
* coordinator, which feeds `resolve` the candidates that have already
* completed a match this event (a `'keyboard'` trigger). Reducing a keydown
* to one descriptor and matching on it here is exactly how sequence chords
* went dead historically, so resolve never sees the chord — only the
* already-matched candidate set, which it filters (modal shadowing) and
* orders.
*/
/**
* When any active context is `modal`, the contributing set collapses to
* `{global, <most-recent-modal>}`; otherwise every active context
* contributes. The `global` carve-out keeps app-wide chords (Cmd+K, …)
* reachable while a modal is up. Most-recent-modal wins because
* `ActiveContextsMap` is insertion-ordered with re-activations rotated to
* the end (see ActiveContexts.tsx).
*
* This is the install/gather filter (which contexts contribute candidates
* at all). Ordering the gathered candidates is `compareContexts`' job.
*/
var computeInstallableContexts = (active, contextConfigsByType) => {
	const contexts = Array.from(active.keys());
	const latestModal = contexts.toReversed().find((type) => contextConfigsByType.get(type)?.modal === true);
	if (!latestModal) return new Set(contexts);
	return new Set([ActionContextTypes.GLOBAL, latestModal]);
};
var PRIORITY_RANK = {
	low: 0,
	default: 1,
	high: 2
};
var TIER_SCOPED = 0;
var TIER_GLOBAL = 1;
var TIER_MODAL = 2;
var tierOf = (type, config) => config?.modal === true ? TIER_MODAL : type === ActionContextTypes.GLOBAL ? TIER_GLOBAL : TIER_SCOPED;
/**
* Order two contexts best-first: modal-over-global, then priority desc,
* then activation-recency desc. Returns a negative number when `a` should
* rank before `b`. The single source of precedence — both the coordinator
* and `getActiveActionById` route through it so dispatch and keyboard
* paths can't disagree.
*/
var compareContexts = (a, b, { active, contextConfigsByType }) => {
	const order = Array.from(active.keys());
	const configA = contextConfigsByType.get(a);
	const configB = contextConfigsByType.get(b);
	return tierOf(b, configB) - tierOf(a, configA) || PRIORITY_RANK[configB?.priority ?? "default"] - PRIORITY_RANK[configA?.priority ?? "default"] || order.indexOf(b) - order.indexOf(a);
};
/**
* Order the actions a trigger could fire, best-first.
*
* For `{kind:'action'}` the input is the full effective-action list and
* `resolve` filters to the matching id. For a keyboard chord
* the coordinator passes the candidates that already completed a match, so
* the only filtering left is "is this context still active + installable".
* Either way the result is ordered by `compareContexts`; the caller takes
* the first (single-winner) or iterates (declinable fall-through, Phase 1
* PR 2).
*/
var resolve = (actions, ctx, trigger) => {
	const installable = trigger.kind === "keyboard" ? computeInstallableContexts(ctx.active, ctx.contextConfigsByType) : void 0;
	return [...actions.filter((action) => {
		switch (trigger.kind) {
			case "action": return ctx.active.has(action.context) && action.id === trigger.actionId;
			case "supplied": return action.id === trigger.actionId;
			case "keyboard": return ctx.active.has(action.context) && installable.has(action.context);
			case "pointer":
			case "gesture": return true;
		}
	})].sort((x, y) => compareContexts(x.context, y.context, ctx));
};
/**
* Resolve the dependency object an action's handler receives: the active
* context's deps merged with any caller-supplied deps, validated at this one
* boundary — the single widened→narrow cast point. Returns `null` when the
* context isn't active or the merged deps fail validation; in the run loop
* that means "skip this candidate, try the next", never abort.
*
* Deliberately NOT an installability check: modal shadowing is the keyboard
* gather filter (`computeInstallableContexts`), layered by the coordinator —
* so imperative `runActionById` still resolves deps for an action in any
* active context.
*
* `supplied` lets callers hand in deps the active map doesn't hold — a pointer
* gesture supplying the CLICKED block's deps, or swipe's `runBlockAction`
* supplying the swiped block's deps. When deps are supplied they STAND ALONE:
* the gesture itself is the activation, so the supplied object is the complete
* dependency set and the active context's deps are NOT merged underneath.
*
* Standalone (rather than `{...base, ...supplied}`) is deliberate and the safer
* contract. A merge lets any field a caller OMITS silently inherit an unrelated
* active instance's value — e.g. a focused embed's `renderScopeId` /
* `scopeRootForcesOpen` leaking into a swipe action and making it focus/open as
* if from that embed. No call site can defend against that without exhaustively
* restating every field on every dispatch; making supplied deps standalone
* retires the whole class at the boundary instead. This is a behaviour change
* only when `action.context` is coincidentally active (the leak case): pointer
* contexts are never activated, and swipe already supplies a complete set, so
* both keep resolving the same deps they did before.
*
* Validation runs only when deps are supplied — active-map deps were already
* validated at activation, so re-validating is redundant. A supplied set that's
* incomplete now fails validation (→ null → skip) rather than borrowing missing
* fields from an unrelated active instance, which is the more correct failure.
*/
var resolveDeps = (action, active, contextConfigsByType, supplied) => {
	if (!supplied) return active.get(action.context) ?? null;
	const config = contextConfigsByType.get(action.context);
	if (config && !config.validateDependencies(supplied)) return null;
	return supplied;
};
//#endregion
export { compareContexts, computeInstallableContexts, resolve, resolveDeps };

//# sourceMappingURL=resolve.js.map