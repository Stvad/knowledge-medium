import { systemToggle } from "../../facets/togglable.js";
import { panelMountsFacet } from "../../extensions/core.js";
import { blockShellDecoratorsFacet } from "../../extensions/blockInteraction.js";
import { __resetSpatialNavigationForTesting, findRecoveryAnchor, horizontalNeighborPanel, locateInstance, panelById, rememberInstancePosition, resolveCurrentAnchor, stackSiblingPanel, verticalNeighbor } from "./walker.js";
import { getSpatialNavigationActionTransforms, getSpatialNavigationActions, getSpatialNavigationDispatchDecorators, spatialNavigationActionDecoratorsExtension, spatialNavigationActionsExtension } from "./actions.js";
import { PanelFocusRecovery } from "./PanelFocusRecovery.js";
import { spatialNavigationShellDecorator } from "./shell.js";
//#region src/plugins/spatial-navigation/index.ts
var panelFocusRecoveryMount = {
	id: "spatial-navigation.panel-focus-recovery",
	component: PanelFocusRecovery
};
var spatialNavigationPlugin = systemToggle({
	id: "system:spatial-navigation",
	name: "Spatial navigation",
	description: "Vim-style h/j/k/l block & panel navigation driven by visible DOM order."
}).of([
	blockShellDecoratorsFacet.of(spatialNavigationShellDecorator, { source: "spatial-navigation" }),
	spatialNavigationActionDecoratorsExtension,
	spatialNavigationActionsExtension,
	panelMountsFacet.of(panelFocusRecoveryMount, { source: "spatial-navigation" })
]);
//#endregion
export { __resetSpatialNavigationForTesting, findRecoveryAnchor, getSpatialNavigationActionTransforms, getSpatialNavigationActions, getSpatialNavigationDispatchDecorators, horizontalNeighborPanel, locateInstance, panelById, rememberInstancePosition, resolveCurrentAnchor, spatialNavigationActionDecoratorsExtension, spatialNavigationActionsExtension, spatialNavigationPlugin, stackSiblingPanel, verticalNeighbor };

//# sourceMappingURL=index.js.map