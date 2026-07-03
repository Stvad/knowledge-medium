import { useAppRuntime } from "../extensions/runtimeContext.js";
import { actionRuntimeKey, getEffectiveActions } from "./effectiveActions.js";
import { c } from "react/compiler-runtime";
//#region src/shortcuts/actionRefItems.ts
var isRecord = (value) => typeof value === "object" && value !== null;
var isActionRefContribution = (value) => isRecord(value) && typeof value.id === "string" && typeof value.actionId === "string" && (value.context === void 0 || typeof value.context === "string");
/**
* Read an action-ref facet and resolve each item to its registered action (the
* presentation/dispatch source), defaulting the lookup context. Memoized on the
* runtime so the effective-action index is rebuilt only when the runtime
* changes — NOT on every focus/edit transition (the surfaces also subscribe to
* active-contexts and would otherwise rebuild the whole action pipeline per
* render). Shared by the mobile bottom nav + keyboard toolbar.
*
* Invariant: items should reference STATICALLY-registered actions. The memo keys
* on `runtime` identity, which does NOT change when an action is added/removed in
* place via `setRuntimeContributions` (the theme + keybinding-override writers do
* this) — so an item pointing at such a runtime-added action wouldn't resolve
* until the next runtime swap. Every current contribution references a static
* action, so this holds; revisit (subscribe to the actions facet) if that breaks.
*/
function useActionRefItems(facet, defaultContext) {
	const $ = c(4);
	const runtime = useAppRuntime();
	let t0;
	if ($[0] !== defaultContext || $[1] !== facet || $[2] !== runtime) {
		const actionsByKey = new Map(getEffectiveActions(runtime).map(_temp));
		t0 = runtime.read(facet).map((item) => ({
			item,
			action: actionsByKey.get(actionRuntimeKey({
				id: item.actionId,
				context: item.context ?? defaultContext
			}))
		}));
		$[0] = defaultContext;
		$[1] = facet;
		$[2] = runtime;
		$[3] = t0;
	} else t0 = $[3];
	return t0;
}
function _temp(a) {
	return [actionRuntimeKey(a), a];
}
//#endregion
export { isActionRefContribution, useActionRefItems };

//# sourceMappingURL=actionRefItems.js.map