import { systemToggle } from "../../facets/togglable.js";
import { actionsFacet } from "../../extensions/core.js";
import { blockContentRendererFacet } from "../../extensions/blockInteraction.js";
import { blockEditingContentRenderer } from "./interactions.js";
import { enterBlockEditModeOnClickAction } from "./clickToEditAction.js";
//#region src/plugins/plain-outliner/index.ts
var plainOutlinerPlugin = systemToggle({
	id: "system:plain-outliner",
	name: "Plain outliner",
	description: "Editable text content renderer + click-to-edit behaviour used for plain text blocks."
}).of([blockContentRendererFacet.of(blockEditingContentRenderer, { source: "plain-outliner" }), actionsFacet.of(enterBlockEditModeOnClickAction, { source: "plain-outliner" })]);
//#endregion
export { plainOutlinerPlugin };

//# sourceMappingURL=index.js.map