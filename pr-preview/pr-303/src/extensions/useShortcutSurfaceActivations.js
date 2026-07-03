import { activePanelIdProp, topLevelBlockIdProp, typesProp } from "../data/properties.js";
import { useRepo } from "../context/repo.js";
import { usePropertyValue } from "../hooks/block.js";
import { useAppRuntime } from "./runtimeContext.js";
import { useBlockContext } from "../context/block.js";
import { useInEditMode, useInFocus, useIsSelected, useUIStateBlock, useUIStateProperty } from "../data/globalState.js";
import { useActionContextActivations } from "../shortcuts/useActionContext.js";
import { shortcutSurfaceActivationsFacet } from "./blockInteraction.js";
import { c } from "react/compiler-runtime";
//#region src/extensions/useShortcutSurfaceActivations.ts
var emptyShortcutSurfaceOptions = {};
/**
* Activate a shortcut surface for a block. Builds the full reactive
* context (block + repo + uiStateBlock + panel envelope + focus / edit
* mode / selection) from hooks and feeds it through the
* `shortcutSurfaceActivationsFacet` resolver. Contributions that gate
* on reactive state (e.g. vim normal mode opting out when the block is
* in edit mode) therefore re-evaluate when that state changes — which
* is what we want for shortcut surface scoping.
*
* Takes `block` directly rather than reading from a React context, so
* it doesn't subscribe to per-block state changes unrelated to
* shortcuts (and so resolver-side facets — layouts, decorators,
* surface props — keep stable identity through reactive updates).
*/
function useShortcutSurfaceActivations(block, surface, t0) {
	const $ = c(25);
	const options = t0 === void 0 ? emptyShortcutSurfaceOptions : t0;
	const repo = useRepo();
	const uiStateBlock = useUIStateBlock();
	const blockContext = useBlockContext();
	const [topLevelBlockId] = useUIStateProperty(topLevelBlockIdProp);
	const [types] = usePropertyValue(block, typesProp);
	const panelId = typeof blockContext.panelId === "string" ? blockContext.panelId : void 0;
	const layoutSessionBlockId = typeof blockContext.layoutSessionBlockId === "string" ? blockContext.layoutSessionBlockId : void 0;
	let t1;
	if ($[0] !== layoutSessionBlockId || $[1] !== repo || $[2] !== uiStateBlock) {
		t1 = layoutSessionBlockId ? repo.block(layoutSessionBlockId) : uiStateBlock;
		$[0] = layoutSessionBlockId;
		$[1] = repo;
		$[2] = uiStateBlock;
		$[3] = t1;
	} else t1 = $[3];
	const [activePanelId] = usePropertyValue(t1, activePanelIdProp);
	const blockInFocus = useInFocus(block.id);
	const surfaceActive = typeof options.surfaceActive === "boolean" ? options.surfaceActive : true;
	const inFocus = blockInFocus && surfaceActive && (!panelId || !layoutSessionBlockId || !activePanelId || activePanelId === panelId);
	const inEditMode = useInEditMode(block.id);
	const isSelected = useIsSelected(block.id);
	const scopeRootId = blockContext.scopeRootId;
	const scopeRootForcesOpen = !blockContext.isNestedSurface;
	const runtime = useAppRuntime();
	let t2;
	if ($[4] !== runtime) {
		t2 = runtime.read(shortcutSurfaceActivationsFacet);
		$[4] = runtime;
		$[5] = t2;
	} else t2 = $[5];
	const resolveShortcutActivations = t2;
	const t3 = block.id === topLevelBlockId && !blockContext.isNestedSurface;
	let t4;
	if ($[6] !== block || $[7] !== blockContext || $[8] !== inEditMode || $[9] !== inFocus || $[10] !== isSelected || $[11] !== options || $[12] !== repo || $[13] !== resolveShortcutActivations || $[14] !== scopeRootForcesOpen || $[15] !== scopeRootId || $[16] !== surface || $[17] !== t3 || $[18] !== topLevelBlockId || $[19] !== types || $[20] !== uiStateBlock) {
		let t5;
		if ($[22] !== scopeRootForcesOpen || $[23] !== scopeRootId) {
			t5 = (activation) => ({
				...activation,
				dependencies: {
					...activation.dependencies ?? {},
					scopeRootId,
					scopeRootForcesOpen
				}
			});
			$[22] = scopeRootForcesOpen;
			$[23] = scopeRootId;
			$[24] = t5;
		} else t5 = $[24];
		t4 = resolveShortcutActivations({
			block,
			repo,
			uiStateBlock,
			types,
			topLevelBlockId,
			scopeRootId,
			isTopLevel: t3,
			blockContext,
			inFocus,
			inEditMode,
			isSelected,
			...options,
			surface
		}).map(t5);
		$[6] = block;
		$[7] = blockContext;
		$[8] = inEditMode;
		$[9] = inFocus;
		$[10] = isSelected;
		$[11] = options;
		$[12] = repo;
		$[13] = resolveShortcutActivations;
		$[14] = scopeRootForcesOpen;
		$[15] = scopeRootId;
		$[16] = surface;
		$[17] = t3;
		$[18] = topLevelBlockId;
		$[19] = types;
		$[20] = uiStateBlock;
		$[21] = t4;
	} else t4 = $[21];
	useActionContextActivations(t4);
}
//#endregion
export { useShortcutSurfaceActivations };

//# sourceMappingURL=useShortcutSurfaceActivations.js.map