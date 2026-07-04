import { propertyEditorOverridesFacet } from "../../data/facets.js";
import { systemToggle } from "../../facets/togglable.js";
import { groupedBacklinksDataExtension } from "./dataExtension.js";
import { defineVariant } from "../../facets/variantFacet.js";
import { backlinksViewFacet } from "../backlinks-view/facet.js";
import { GroupedLinkedReferences } from "./GroupedLinkedReferences.js";
import { groupedBacklinksDefaultsUi } from "./propertyEditorOverride.js";
//#region src/plugins/grouped-backlinks/index.ts
var groupedBacklinksPlugin = systemToggle({
	id: "system:grouped-backlinks",
	name: "Grouped backlinks",
	description: "Backlinks grouped by a configurable property (defaults to the type of the source block)."
}).of([
	groupedBacklinksDataExtension,
	propertyEditorOverridesFacet.of(groupedBacklinksDefaultsUi, { source: "grouped-backlinks" }),
	backlinksViewFacet.of(() => defineVariant("grouped", "Grouped", GroupedLinkedReferences), { source: "grouped-backlinks" })
]);
//#endregion
export { groupedBacklinksPlugin };

//# sourceMappingURL=index.js.map