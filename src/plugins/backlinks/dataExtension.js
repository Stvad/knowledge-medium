import { propertySchemasFacet, queriesFacet } from "../../data/facets.js";
import { pluginPrefsExtension } from "../../data/pluginStateExtensions.js";
import { backlinksForBlockQuery } from "./query.js";
import { backlinksFilterProp } from "./filterProperty.js";
import { backlinksPrefsType, dailyNoteBacklinksDefaultsProp } from "./dailyNoteDefaults.js";
//#region src/plugins/backlinks/dataExtension.ts
var backlinksDataExtension = [
	queriesFacet.of(backlinksForBlockQuery, { source: "backlinks" }),
	propertySchemasFacet.of(backlinksFilterProp, { source: "backlinks" }),
	propertySchemasFacet.of(dailyNoteBacklinksDefaultsProp, { source: "backlinks" }),
	...pluginPrefsExtension(backlinksPrefsType, "backlinks")
];
//#endregion
export { backlinksDataExtension };

//# sourceMappingURL=dataExtension.js.map