import { ChangeScope } from "../../data/api/changeScope.js";
import "../../data/api/index.js";
import { activePanelIdProp, focusBlock, focusedBlockLocationProp, isEditingProp, peekFocusedBlockLocation, sameFocusedBlockLocation, selectionStateProp } from "../../data/properties.js";
import { actionTransformsFacet, actionsFacet } from "../../extensions/core.js";
import { ActionContextTypes } from "../../shortcuts/types.js";
import { blockIdsInOrderedSelectionRange, commitSelectionRange, findBestSelectionAnchorIndex } from "../../utils/selection.js";
import { actionDispatchWrap } from "../../shortcuts/actionDispatch.js";
import { EXTEND_BLOCK_SELECTION_ACTION_ID } from "../../extensions/blockSelectionAction.js";
import { bindBlockActionContext } from "../../shortcuts/blockActions.js";
import { horizontalNeighborPanel, locationOf, panelById, panelInstances, panelOf, resolveCurrentAnchor, verticalNeighbor } from "./walker.js";
//#region src/plugins/spatial-navigation/actions.ts
/**
* Locate the anchor instance to walk from. Prefers the live DOM
* instance for the focused block; if it's missing (e.g. a backlink
* was just rescheduled and its entry unmounted while the proactive
* recovery is still in its debounce window), falls back to the same
* recovery anchor `PanelFocusRecovery` would pick. Without that
* fallback, a keystroke during the window would return null →
* `moveVertical` returns false → vim's data-model walker takes over
* and may cross panels (see `moveVertical`'s false-return contract).
*/
var currentInstance = (deps) => {
	const { block, uiStateBlock } = deps;
	if (!block || !uiStateBlock) return null;
	if (typeof document === "undefined") return null;
	const focusedLocation = deps.renderScopeId ? {
		blockId: block.id,
		renderScopeId: deps.renderScopeId
	} : peekFocusedBlockLocation(uiStateBlock);
	return resolveCurrentAnchor(uiStateBlock.id, focusedLocation);
};
var locationsOf = (instances) => {
	const locations = instances.map(locationOf);
	return locations.every((location) => Boolean(location)) ? locations : null;
};
var extendSelectionToSpatialTarget = async (deps, target) => {
	const { uiStateBlock } = deps;
	if (!uiStateBlock) return false;
	const targetLocation = locationOf(target);
	if (!targetLocation) return false;
	const panel = panelOf(target);
	if (!panel || panel.dataset.panelId !== uiStateBlock.id) return true;
	const currentState = uiStateBlock.peekProperty(selectionStateProp);
	const currentLocation = peekFocusedBlockLocation(uiStateBlock);
	const anchorBlockId = currentState?.anchorBlockId ?? currentLocation?.blockId;
	if (!anchorBlockId) return false;
	const instances = panelInstances(panel);
	const orderedLocations = locationsOf(instances);
	if (!orderedLocations) return false;
	const targetIndex = instances.indexOf(target);
	const anchorIndex = findBestSelectionAnchorIndex(orderedLocations, {
		anchorBlockId,
		targetIndex,
		selectedBlockIds: currentState?.selectedBlockIds,
		currentLocation
	});
	if (anchorIndex < 0) return false;
	return commitSelectionRange({
		uiStateBlock,
		anchorBlockId,
		targetLocation,
		selectedBlockIds: blockIdsInOrderedSelectionRange(orderedLocations, anchorIndex, targetIndex),
		clearEditing: true,
		description: "spatial-navigation extend selection"
	});
};
var extendSelectionVertical = async (deps, direction) => {
	const { uiStateBlock } = deps;
	if (!uiStateBlock) return false;
	if (typeof document === "undefined") return false;
	const focusedLocation = peekFocusedBlockLocation(uiStateBlock);
	if (!focusedLocation) return false;
	const current = resolveCurrentAnchor(uiStateBlock.id, focusedLocation);
	if (!current) return true;
	const currentLocation = locationOf(current);
	if (!currentLocation) return false;
	if (!sameFocusedBlockLocation(currentLocation, focusedLocation)) {
		await extendSelectionToSpatialTarget(deps, current);
		return true;
	}
	if (!((uiStateBlock.peekProperty(selectionStateProp)?.selectedBlockIds.length ?? 0) > 0)) {
		await extendSelectionToSpatialTarget(deps, current);
		return true;
	}
	const next = verticalNeighbor(current, direction);
	if (!next) return true;
	await extendSelectionToSpatialTarget(deps, next);
	return true;
};
/**
* Move spatial focus within a panel. Mirrors vim's `move_down` /
* `move_up` behavior exactly: write the new focused block id to the
* panel block via `focusBlock`. No DOM-focus call, no scroll — the
* kernel `BlockFocusShellDecorator` already drives both
* (highlight class via `useInFocus`, scroll via its own effect)
* off the same prop. Adding our own DOM mutations would just race.
*
* Return contract (intentionally different from "did we move?"):
*   - `false` → "no anchor; please fall through to the underlying
*     vim handler". Only the `!current` early return takes this
*     path — neither a live focused instance nor a recovery anchor
*     exists, so vim's data-model walk is a legitimate fallback.
*   - `true` → "spatial nav handled this keystroke". Includes the
*     no-neighbor / panel-boundary case. We must NOT fall through
*     to vim's `nextVisibleBlock` for a panel-boundary block on a
*     non-outline surface (backlinks, embeds): vim's walker climbs
*     the data-model parent chain of the source block, which for a
*     backlink entry lives in some other page entirely. Following
*     that chain returns a block from elsewhere in the workspace,
*     and writing it as the panel's `focusedBlockLocation` leaves
*     `useInFocus(<anyone in this panel>)` returning false →
*     normal-mode deactivates → all shortcuts go dead until the
*     user clicks back into a block.
*/
var moveVertical = async (deps, direction) => {
	const { block, uiStateBlock } = deps;
	if (!block || !uiStateBlock) return false;
	const expectedLocation = deps.renderScopeId ? {
		blockId: block.id,
		renderScopeId: deps.renderScopeId
	} : peekFocusedBlockLocation(uiStateBlock);
	const current = currentInstance(deps);
	if (!current) return Boolean(expectedLocation);
	const currentLocation = locationOf(current);
	if (!currentLocation) return false;
	if (expectedLocation && (currentLocation.blockId !== expectedLocation.blockId || currentLocation.renderScopeId !== expectedLocation.renderScopeId)) {
		focusBlock(uiStateBlock, currentLocation.blockId, { renderScopeId: currentLocation.renderScopeId });
		return true;
	}
	const next = verticalNeighbor(current, direction);
	if (!next) return true;
	const destPanel = next.closest("[data-panel-id]");
	if (!destPanel) return true;
	const destPanelId = destPanel.dataset.panelId;
	const destLocation = locationOf(next);
	if (!destPanelId || !destLocation) return true;
	if (destPanelId === uiStateBlock.id) {
		focusBlock(uiStateBlock, destLocation.blockId, { renderScopeId: destLocation.renderScopeId });
		return true;
	}
	await crossPanelFocus(uiStateBlock, destPanelId, destLocation);
	return true;
};
var moveHorizontal = async (deps, direction) => {
	const { block, uiStateBlock } = deps;
	if (!block || !uiStateBlock) return false;
	const current = currentInstance(deps);
	if (!current) return false;
	const destPanel = horizontalNeighborPanel(current, direction);
	if (!destPanel) return false;
	const destPanelId = destPanel.dataset.panelId;
	if (!destPanelId) return false;
	const destLocation = peekFocusedBlockLocation(uiStateBlock.repo.block(destPanelId)) ?? findFirstInstanceLocation(destPanel);
	if (!destLocation) return false;
	await crossPanelFocus(uiStateBlock, destPanelId, destLocation);
	return true;
};
var findFirstInstanceLocation = (panel) => {
	for (const instance of panelInstances(panel)) {
		const location = locationOf(instance);
		if (location) return location;
	}
};
var crossPanelFocus = async (sourcePanelBlock, destPanelId, destLocation) => {
	const repo = sourcePanelBlock.repo;
	const destPanelBlock = repo.block(destPanelId);
	const layoutSessionId = (typeof document !== "undefined" ? document.querySelector("[data-layout-session-id]") : null)?.dataset.layoutSessionId;
	await repo.tx(async (tx) => {
		if (layoutSessionId) await tx.setProperty(layoutSessionId, activePanelIdProp, destPanelId);
		await tx.setProperty(destPanelBlock.id, focusedBlockLocationProp, destLocation);
		if (destPanelBlock.peekProperty(isEditingProp) === true) await tx.setProperty(destPanelBlock.id, isEditingProp, false);
	}, {
		scope: ChangeScope.UiState,
		description: "spatial-navigation cross-panel focus"
	});
};
/**
* Jump focus to the first / last navigable instance in the panel, in
* visible DOM order. This is the `gg` / `Shift+G` counterpart to
* `moveVertical`: since spatial nav steps `j`/`k` through the rendered
* DOM (outline bullets *and* trailing surfaces like backlinks/embeds),
* the edges must bound that same sequence — otherwise `Shift+G` would
* stop at the last data-tree descendant and skip the backlinks the user
* can still `j` into. Same return contract as `moveVertical`: `false`
* means "no live panel DOM — fall through to vim's data-model handler"
* (SSR/headless, or the panel hasn't mounted); `true` means handled.
*/
var jumpToPanelEdge = async (deps, edge) => {
	const { uiStateBlock } = deps;
	if (!uiStateBlock) return false;
	if (typeof document === "undefined") return false;
	const panel = panelById(uiStateBlock.id);
	if (!panel) return false;
	const instances = panelInstances(panel);
	if (instances.length === 0) return false;
	const location = locationOf(edge === "first" ? instances[0] : instances[instances.length - 1]);
	if (!location) return false;
	await focusBlock(uiStateBlock, location.blockId, { renderScopeId: location.renderScopeId });
	return true;
};
function getSpatialNavigationActions() {
	const bindNormal = (action) => bindBlockActionContext(ActionContextTypes.NORMAL_MODE, action);
	return [bindNormal({
		id: "move_left",
		description: "Move focus to the panel on the left",
		handler: async (deps) => {
			await moveHorizontal(deps, "left");
		},
		defaultBinding: { keys: ["ArrowLeft", "h"] }
	}), bindNormal({
		id: "move_right",
		description: "Move focus to the panel on the right",
		handler: async (deps) => {
			await moveHorizontal(deps, "right");
		},
		defaultBinding: { keys: ["ArrowRight", "l"] }
	})];
}
var verticalDescriptionTransform = (actionId, description) => ({
	actionId,
	context: ActionContextTypes.NORMAL_MODE,
	apply: (action) => ({
		...action,
		description
	})
});
var verticalDispatchDecorator = (actionId, direction) => ({
	actionId,
	context: ActionContextTypes.NORMAL_MODE,
	wrap: async (deps, trigger, next, dispatch) => {
		if (await moveVertical(deps, direction)) return;
		await next(deps, trigger, dispatch);
	}
});
var jumpEdgeDispatchDecorator = (actionId, edge) => ({
	actionId,
	context: ActionContextTypes.NORMAL_MODE,
	wrap: async (deps, trigger, next, dispatch) => {
		if (await jumpToPanelEdge(deps, edge)) return;
		await next(deps, trigger, dispatch);
	}
});
var selectionVerticalDispatchDecorator = (actionId, context, direction) => ({
	actionId,
	context,
	wrap: async (deps, trigger, next, dispatch) => {
		if (await extendSelectionVertical(deps, direction)) return;
		await next(deps, trigger, dispatch);
	}
});
/**
* Shift-click selection in visible DOM order — a DISPATCH decorator on the
* structural `extend_block_selection` action, the mouse-side counterpart of
* `selectionVerticalDispatchDecorator`: anchor → clicked block range across
* whatever is on screen (backlinks, embeds), not the data tree. Declines back to
* the structural base (via `next`) when no spatial range resolves (e.g. the
* clicked instance isn't in this panel / isn't a navigable item).
*
* `deps.targetElement` is the block shell the block-pointer dispatch captured —
* the same element the spatial shell decorator tags with `data-block-nav-item`,
* so the walker can locate it. Upstream gating (selection-gesture + exact
* shift-only pointer binding) means this only ever sees a plain shift-click, so
* it no longer re-checks modifiers or interactive content.
*/
var spatialSelectionClickDecorator = {
	actionId: EXTEND_BLOCK_SELECTION_ACTION_ID,
	context: ActionContextTypes.BLOCK_POINTER,
	wrap: async (deps, trigger, next, dispatch) => {
		const { uiStateBlock, targetElement } = deps;
		if (panelOf(targetElement)?.dataset.panelId === uiStateBlock.id) {
			if (await extendSelectionToSpatialTarget({ uiStateBlock }, targetElement)) return;
		}
		await next(deps, trigger, dispatch);
	}
};
/** Presentational labels for the vertical-move actions — stays on the
*  definition-transform seam (binding/metadata shaping). */
function getSpatialNavigationActionTransforms() {
	return [verticalDescriptionTransform("move_down", "Move focus down (next block, then stack-sibling panel below)"), verticalDescriptionTransform("move_up", "Move focus up (previous block, then stack-sibling panel above)")];
}
/** Behaviour wraps (move-then-fall-through, jump-to-edge, selection-extend,
*  shift-click range) on the action-dispatch seam — migrated off
*  `actionTransformsFacet`. */
function getSpatialNavigationDispatchDecorators() {
	return [
		verticalDispatchDecorator("move_down", "down"),
		verticalDispatchDecorator("move_up", "up"),
		jumpEdgeDispatchDecorator("jump_to_first_visible_block", "first"),
		jumpEdgeDispatchDecorator("jump_to_last_visible_block", "last"),
		selectionVerticalDispatchDecorator("extend_selection_down", ActionContextTypes.NORMAL_MODE, "down"),
		selectionVerticalDispatchDecorator("extend_selection_up", ActionContextTypes.NORMAL_MODE, "up"),
		selectionVerticalDispatchDecorator("multi_select.extend_selection_down", ActionContextTypes.MULTI_SELECT_MODE, "down"),
		selectionVerticalDispatchDecorator("multi_select.extend_selection_up", ActionContextTypes.MULTI_SELECT_MODE, "up"),
		spatialSelectionClickDecorator
	];
}
var spatialNavigationActionsExtension = getSpatialNavigationActions().map((action) => actionsFacet.of(action, { source: "spatial-navigation" }));
var spatialNavigationActionDecoratorsExtension = [...getSpatialNavigationActionTransforms().map((transform) => actionTransformsFacet.of(transform, { source: "spatial-navigation" })), ...getSpatialNavigationDispatchDecorators().map((decorator) => actionDispatchWrap(decorator, { source: "spatial-navigation" }))];
//#endregion
export { extendSelectionToSpatialTarget, getSpatialNavigationActionTransforms, getSpatialNavigationActions, getSpatialNavigationDispatchDecorators, spatialNavigationActionDecoratorsExtension, spatialNavigationActionsExtension, spatialSelectionClickDecorator };

//# sourceMappingURL=actions.js.map