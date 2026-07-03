import { propertySchemasFacet } from "../../data/facets.js";
import { systemToggle } from "../../facets/togglable.js";
import { blockChildrenFooterFacet } from "../../extensions/blockInteraction.js";
import { backlinksViewProp } from "./prop.js";
import { backlinksViewFooterContribution } from "./BacklinksViewSection.js";
//#region src/plugins/backlinks-view/index.ts
var backlinksViewPlugin = systemToggle({
	id: "system:backlinks-view",
	name: "Backlinks view",
	description: "Picker that switches each block between the flat and grouped backlinks renderings."
}).of([propertySchemasFacet.of(backlinksViewProp, { source: "backlinks-view" }), blockChildrenFooterFacet.of(backlinksViewFooterContribution, { source: "backlinks-view" })]);
//#endregion
export { backlinksViewPlugin };

//# sourceMappingURL=index.js.map