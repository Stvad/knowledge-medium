import { actionTransformsFacet, actionsFacet } from "../extensions/core.js";
import { keybindingOverridesFacet } from "./keybindingOverrides.js";
import { applyKeybindingOverrides } from "./applyKeybindingOverrides.js";
import { resolve } from "./resolve.js";
//#region src/shortcuts/effectiveActions.ts
var actionRuntimeKey = (action) => `${action.context}:${action.id}`;
/** Sentinel `actionId` that matches every action. Use sparingly — most
*  transforms target a specific id. The cross-action keybinding-override
*  pass (`applyKeybindingOverrides`, run after this pipeline) is the main
*  whole-list consumer: it reads the `keybindingOverridesFacet` and
*  rewrites whichever actions the user has remapped, inspecting every
*  action so it can also strip a default chord that lost a collision to a
*  user override. */
var WILDCARD_ACTION_ID = "*";
/** Does a per-action target (`{actionId, context?}`) apply to `action`?
*  `actionId` may be {@link WILDCARD_ACTION_ID} (`'*'`) to match every action;
*  `context` (when set) narrows to one context. Shared by both the
*  `actionTransformsFacet` pipeline here and the action-dispatch seam's
*  `actionDispatchWrap` (same targeting on the definition and invocation sides). */
var matchesAction = (target, action) => (target.actionId === "*" || target.actionId === action.id) && (target.context === void 0 || target.context === action.context);
/** The action list after every `actionTransformsFacet` contribution has
*  been applied, but before any keybinding-override rewrites. Used by the
*  settings UI so it can preview an unsaved `StoredKeybindingOverrides`
*  map without waiting for the runtime rebuild that happens after the
*  canonical prefs block subscription fires.
*
*  Transforms run in the runtime's order (precedence asc, then
*  registration), so a later contribution wraps the earlier ones. */
var getActionsBeforeKeybindingOverrides = (runtime) => {
	const transforms = runtime.read(actionTransformsFacet);
	const out = [];
	for (const rawAction of runtime.read(actionsFacet)) {
		let action = rawAction;
		for (const transform of transforms) {
			if (!action || !matchesAction(transform, action)) continue;
			action = transform.apply(action);
		}
		if (action) out.push(action);
	}
	return out;
};
var getEffectiveActions = (runtime) => {
	return applyKeybindingOverrides(getActionsBeforeKeybindingOverrides(runtime), runtime.read(keybindingOverridesFacet));
};
/**
* The active action for an id, resolved through the shared precedence core
* so this (the imperative `runActionById` / `useRunAction` path) and the
* keyboard path can't diverge. Behaviour change vs the old pure
* reverse-activation lookup: a `global`-vs-scoped id collision now resolves
* to `global` (reserved top tier) instead of to whichever was activated
* most recently. Modal shadowing is NOT applied here — imperative
* invocation finds an action in any active context (see `resolve`).
*/
var getActiveActionById = (actions, ctx, actionId) => resolve(actions, ctx, {
	kind: "action",
	actionId
})[0] ?? null;
//#endregion
export { WILDCARD_ACTION_ID, actionRuntimeKey, getActionsBeforeKeybindingOverrides, getActiveActionById, getEffectiveActions, matchesAction };

//# sourceMappingURL=effectiveActions.js.map