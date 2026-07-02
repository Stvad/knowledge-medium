import { propertyEditorOverridesFacet } from "../../data/facets.js";
import { systemToggle } from "../../facets/togglable.js";
import { backlinksDataExtension } from "./dataExtension.js";
import { defineVariant } from "../../facets/variantFacet.js";
import { backlinksViewFacet } from "../backlinks-view/facet.js";
import { backlinkBreadcrumbShortcutsExtension } from "./backlinkBreadcrumbShortcuts.js";
import { LinkedReferences } from "./LinkedReferences.js";
import { dailyNoteBacklinksDefaultsUi } from "./propertyEditorOverride.js";
import { inlineBacklinkCountsExtension } from "./inline-counts/index.js";
//#region src/plugins/backlinks/index.ts
var backlinksPlugin = systemToggle({
	id: "system:backlinks",
	name: "Backlinks",
	description: "Flat list of incoming references to the focused block."
}).of([
	backlinksDataExtension,
	backlinkBreadcrumbShortcutsExtension,
	propertyEditorOverridesFacet.of(dailyNoteBacklinksDefaultsUi, { source: "backlinks" }),
	backlinksViewFacet.of(() => defineVariant("flat", "Flat", LinkedReferences), { source: "backlinks" }),
	inlineBacklinkCountsExtension
]);
//#endregion
export { backlinksPlugin };

//# sourceMappingURL=index.js.map