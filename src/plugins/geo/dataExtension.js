import { propertySchemasFacet, queriesFacet, systemPagesFacet, typesFacet } from "../../data/facets.js";
import { codeMirrorExtensionsFacet } from "../../editor/codeMirrorExtensions.js";
import { GEO_PROPERTY_SCHEMAS } from "./properties.js";
import { GEO_TYPE_CONTRIBUTIONS } from "./blockTypes.js";
import { getOrCreateLocationsPage } from "./locationsPage.js";
import { geoCodeMirrorExtensions } from "./codeMirrorExtensions.js";
import { placesUnderBlockQuery } from "./query.js";
//#region src/plugins/geo/dataExtension.ts
/** Data-layer contributions for the geo plugin — types, property
*  schemas, queries, and the CodeMirror surface (theme + `@`
*  completion source via languageData). Composed into the user-facing
*  `geoPlugin` in `./index.ts`. */
var geoDataExtension = [
	GEO_TYPE_CONTRIBUTIONS.map((t) => typesFacet.of(t, { source: "geo" })),
	GEO_PROPERTY_SCHEMAS.map((s) => propertySchemasFacet.of(s, { source: "geo" })),
	queriesFacet.of(placesUnderBlockQuery, { source: "geo" }),
	codeMirrorExtensionsFacet.of(geoCodeMirrorExtensions, { source: "geo" }),
	systemPagesFacet.of({
		id: "geo:locations",
		ensure: getOrCreateLocationsPage
	}, { source: "geo" })
];
//#endregion
export { geoDataExtension };

//# sourceMappingURL=dataExtension.js.map