import { Button } from "../../components/ui/button.js";
import { useAppRuntime } from "../../extensions/runtimeContext.js";
import { ActionContextTypes } from "../../shortcuts/types.js";
import { useUIStateBlock } from "../../data/globalState.js";
import { getEffectiveActions } from "../../shortcuts/effectiveActions.js";
import { dispatchActionWithDeps } from "../../shortcuts/runAction.js";
import { c } from "react/compiler-runtime";
import { jsx } from "react/jsx-runtime";
//#region src/plugins/grouped-backlinks/GroupHeaderActionButton.tsx
/** Renders a single grouped-backlinks header button that invokes a
*  registered `MULTI_SELECT_MODE` action with the group's blocks.
*
*  Resolves the action from the runtime at render time rather than
*  at facet-contribution time so contributions don't have to be
*  ordered with the action registration. If the action isn't
*  registered, or its `isVisible` predicate rejects the synthesized
*  deps, the button renders nothing — same affordance-hiding
*  contract as the command palette. */
var GroupHeaderActionButton = (t0) => {
	const $ = c(20);
	const { actionId, sourceBlocks, icon: iconOverride, label: labelOverride, triggerDetail } = t0;
	const runtime = useAppRuntime();
	const uiStateBlock = useUIStateBlock();
	let t1;
	if ($[0] !== actionId || $[1] !== runtime) {
		const effective = getEffectiveActions(runtime);
		let t2;
		if ($[3] !== actionId) {
			t2 = (candidate) => candidate.id === actionId && candidate.context === ActionContextTypes.MULTI_SELECT_MODE;
			$[3] = actionId;
			$[4] = t2;
		} else t2 = $[4];
		t1 = effective.find(t2);
		$[0] = actionId;
		$[1] = runtime;
		$[2] = t1;
	} else t1 = $[2];
	const action = t1;
	if (!action) return null;
	const t2 = sourceBlocks;
	let deps;
	let t3;
	if ($[5] !== action || $[6] !== t2 || $[7] !== uiStateBlock) {
		deps = {
			selectedBlocks: t2,
			anchorBlock: null,
			uiStateBlock
		};
		t3 = action.isVisible && !action.isVisible(deps);
		$[5] = action;
		$[6] = t2;
		$[7] = uiStateBlock;
		$[8] = deps;
		$[9] = t3;
	} else {
		deps = $[8];
		t3 = $[9];
	}
	if (t3) return null;
	const Icon = iconOverride ?? action.icon;
	const label = labelOverride ?? action.description;
	let t4;
	if ($[10] !== actionId || $[11] !== deps || $[12] !== triggerDetail) {
		t4 = (event) => {
			event.stopPropagation();
			const trigger = new CustomEvent(`group-header:${actionId}`, { detail: triggerDetail });
			dispatchActionWithDeps(actionId, deps, trigger);
		};
		$[10] = actionId;
		$[11] = deps;
		$[12] = triggerDetail;
		$[13] = t4;
	} else t4 = $[13];
	const handleClick = t4;
	let t5;
	if ($[14] !== Icon) {
		t5 = Icon && /* @__PURE__ */ jsx(Icon, { className: "h-3.5 w-3.5" });
		$[14] = Icon;
		$[15] = t5;
	} else t5 = $[15];
	let t6;
	if ($[16] !== handleClick || $[17] !== label || $[18] !== t5) {
		t6 = /* @__PURE__ */ jsx(Button, {
			type: "button",
			variant: "ghost",
			size: "icon",
			className: "h-6 w-6 shrink-0 rounded-sm text-muted-foreground hover:text-foreground",
			title: label,
			"aria-label": label,
			onClick: handleClick,
			children: t5
		});
		$[16] = handleClick;
		$[17] = label;
		$[18] = t5;
		$[19] = t6;
	} else t6 = $[19];
	return t6;
};
//#endregion
export { GroupHeaderActionButton };

//# sourceMappingURL=GroupHeaderActionButton.js.map