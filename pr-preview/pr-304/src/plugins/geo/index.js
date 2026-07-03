import { propertyEditorOverridesFacet } from "../../data/facets.js";
import { systemToggle } from "../../facets/togglable.js";
import { geoDataExtension } from "./dataExtension.js";
import { blockContentDecoratorsFacet } from "../../extensions/blockInteraction.js";
import { referencesPlugin } from "../references/index.js";
import { geoContentDecoratorContribution } from "./geoContentDecorator.js";
import { locationPropertyEditorOverride } from "./propertyEditorOverrides.js";
//#region src/plugins/geo/index.ts
/** Geo plugin — physical-world location references. See the project
*  plan at [.claude/plans/compiled-wobbling-kahan.md] for the full
*  design.
*
*  Composes its dependencies (currently `referencesPlugin`) directly
*  into its `AppExtension` array. Facet-level dedup means listing the
*  same dependency in `staticAppExtensions` is harmless — order is
*  irrelevant. */
var geoPlugin = systemToggle({
	id: "system:geo",
	name: "Locations",
	description: "Physical-world location references — Place blocks, @ autocomplete, and map views."
}).of([
	referencesPlugin,
	geoDataExtension,
	blockContentDecoratorsFacet.of(geoContentDecoratorContribution, { source: "geo" }),
	propertyEditorOverridesFacet.of(locationPropertyEditorOverride, { source: "geo" })
]);
//#endregion
export { geoPlugin };

//# sourceMappingURL=index.js.map