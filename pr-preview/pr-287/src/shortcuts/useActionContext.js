import { ActionContextTypes } from "./types.js";
import { useActiveContextsDispatch } from "./ActiveContexts.js";
import { useUIStateBlock } from "../data/globalState.js";
import { useEffect } from "react";
import { c } from "react/compiler-runtime";
//#region src/shortcuts/useActionContext.ts
/**
* Hook to activate any number of shortcut contexts described by facet contributions.
*/
function useActionContextActivations(activations) {
	const $ = c(10);
	const uiStateBlock = useUIStateBlock();
	const { activate, deactivate } = useActiveContextsDispatch();
	let t0;
	if ($[0] !== activations || $[1] !== uiStateBlock) {
		let t1;
		if ($[3] !== uiStateBlock) {
			t1 = (activation_0) => ({
				context: activation_0.context,
				dependencies: {
					...activation_0.dependencies ?? {},
					uiStateBlock
				}
			});
			$[3] = uiStateBlock;
			$[4] = t1;
		} else t1 = $[4];
		t0 = activations.filter(_temp).map(t1);
		$[0] = activations;
		$[1] = uiStateBlock;
		$[2] = t0;
	} else t0 = $[2];
	const activeActivations = t0;
	let t1;
	let t2;
	if ($[5] !== activate || $[6] !== activeActivations || $[7] !== deactivate) {
		t1 = () => {
			if (!activeActivations.length) return;
			for (const activation_1 of activeActivations) activate(activation_1.context, activation_1.dependencies);
			return () => {
				for (const activation_2 of activeActivations) deactivate(activation_2.context);
			};
		};
		t2 = [
			activeActivations,
			activate,
			deactivate
		];
		$[5] = activate;
		$[6] = activeActivations;
		$[7] = deactivate;
		$[8] = t1;
		$[9] = t2;
	} else {
		t1 = $[8];
		t2 = $[9];
	}
	useEffect(t1, t2);
}
/**
* Hook to activate a shortcut context
* @param context The context to activate
* @param dependencies Dependencies to pass to the handlers
* @param enabled Whether the context is enabled (defaults to true)
*/
function _temp(activation) {
	return activation.enabled !== false;
}
function useActionContext(context, t0, t1) {
	const $ = c(4);
	const dependencies = t0 === void 0 ? null : t0;
	const enabled = t1 === void 0 ? true : t1;
	const t2 = dependencies;
	let t3;
	if ($[0] !== context || $[1] !== enabled || $[2] !== t2) {
		t3 = [{
			context,
			dependencies: t2,
			enabled
		}];
		$[0] = context;
		$[1] = enabled;
		$[2] = t2;
		$[3] = t3;
	} else t3 = $[3];
	useActionContextActivations(t3);
}
/**
* Hook for normal mode shortcuts
*/
function useNormalModeShortcuts(dependencies, t0) {
	const enabled = t0 === void 0 ? true : t0;
	useActionContext(ActionContextTypes.NORMAL_MODE, dependencies, enabled);
}
/**
* Hook for CodeMirror edit mode shortcuts
*/
function useCodeMirrorEditModeShortcuts(dependencies, enabled) {
	useActionContext(ActionContextTypes.EDIT_MODE_CM, dependencies, enabled);
}
/**
* Hook for property editing shortcuts
*/
function usePropertyEditingShortcuts(dependencies, t0) {
	const enabled = t0 === void 0 ? true : t0;
	useActionContext(ActionContextTypes.PROPERTY_EDITING, dependencies, enabled);
}
//#endregion
export { useActionContext, useActionContextActivations, useCodeMirrorEditModeShortcuts, useNormalModeShortcuts, usePropertyEditingShortcuts };

//# sourceMappingURL=useActionContext.js.map