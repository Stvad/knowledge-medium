import { actionContextsFacet } from "../../extensions/core.js";
import { useAppRuntime } from "../../extensions/runtimeContext.js";
import { useActiveContextsState } from "../../shortcuts/ActiveContexts.js";
import { actionRuntimeKey, getEffectiveActions } from "../../shortcuts/effectiveActions.js";
import { COMMAND_PALETTE_ACTION_ID, COMMAND_PALETTE_FOR_BLOCK_ACTION_ID } from "./context.js";
import { c } from "react/compiler-runtime";
//#region src/plugins/command-palette/useCommandPaletteActions.ts
var PALETTE_HIDDEN_FROM_PALETTE = new Set([COMMAND_PALETTE_ACTION_ID, COMMAND_PALETTE_FOR_BLOCK_ACTION_ID]);
var NO_BINDINGS = [];
function useCommandPaletteActions() {
	const $ = c(21);
	const runtime = useAppRuntime();
	const active = useActiveContextsState();
	let t0;
	if ($[0] !== runtime) {
		const contextConfigs = runtime.read(actionContextsFacet);
		t0 = new Map(contextConfigs.map(_temp));
		$[0] = runtime;
		$[1] = t0;
	} else t0 = $[1];
	const configsByType = t0;
	let bindingsByActionId;
	if ($[2] !== runtime) {
		const allActions = getEffectiveActions(runtime);
		bindingsByActionId = /* @__PURE__ */ new Map();
		for (const action of allActions) {
			if (!action.defaultBinding) continue;
			bindingsByActionId.set(actionRuntimeKey(action), [{
				...action.defaultBinding,
				action: action.id
			}]);
		}
		$[2] = runtime;
		$[3] = bindingsByActionId;
	} else bindingsByActionId = $[3];
	let t1;
	if ($[4] !== bindingsByActionId) {
		t1 = (action_0) => bindingsByActionId.get(actionRuntimeKey(action_0)) ?? NO_BINDINGS;
		$[4] = bindingsByActionId;
		$[5] = t1;
	} else t1 = $[5];
	const getBindings = t1;
	let t2;
	if ($[6] !== configsByType || $[7] !== getBindings) {
		t2 = {
			contextConfigsByType: configsByType,
			bindingsFor: getBindings
		};
		$[6] = configsByType;
		$[7] = getBindings;
		$[8] = t2;
	} else t2 = $[8];
	const { contextConfigsByType, bindingsFor } = t2;
	let t3;
	if ($[9] !== active || $[10] !== runtime) {
		const allActions_0 = getEffectiveActions(runtime);
		let t4;
		if ($[12] !== active) {
			t4 = (action_1) => {
				if (!active.has(action_1.context)) return false;
				if (PALETTE_HIDDEN_FROM_PALETTE.has(action_1.id)) return false;
				if (!action_1.isVisible) return true;
				const deps = active.get(action_1.context);
				if (!deps) return true;
				return action_1.isVisible(deps);
			};
			$[12] = active;
			$[13] = t4;
		} else t4 = $[13];
		t3 = allActions_0.filter(t4);
		$[9] = active;
		$[10] = runtime;
		$[11] = t3;
	} else t3 = $[11];
	const actions = t3;
	let t4;
	if ($[14] !== active || $[15] !== contextConfigsByType) {
		t4 = Array.from(active.entries()).flatMap((t5) => {
			const [type, dependencies] = t5;
			const config = contextConfigsByType.get(type);
			return config ? [{
				config,
				dependencies
			}] : [];
		});
		$[14] = active;
		$[15] = contextConfigsByType;
		$[16] = t4;
	} else t4 = $[16];
	const activeContexts = t4;
	let t5;
	if ($[17] !== actions || $[18] !== activeContexts || $[19] !== bindingsFor) {
		t5 = {
			actions,
			activeContexts,
			bindingsFor
		};
		$[17] = actions;
		$[18] = activeContexts;
		$[19] = bindingsFor;
		$[20] = t5;
	} else t5 = $[20];
	return t5;
}
function _temp(c) {
	return [c.type, c];
}
//#endregion
export { useCommandPaletteActions };

//# sourceMappingURL=useCommandPaletteActions.js.map