import { propertySchemasFacet, queriesFacet } from "../../data/facets.js";
import { pluginPrefsExtension } from "../../data/pluginStateExtensions.js";
import { groupWithProp, groupedBacklinksDefaultsProp, groupedBacklinksOverridesProp, groupedBacklinksPrefsType } from "./config.js";
import { groupedBacklinksForBlockQuery } from "./query.js";
//#region src/plugins/grouped-backlinks/dataExtension.ts
var groupedBacklinksDataExtension = [
	propertySchemasFacet.of(groupedBacklinksDefaultsProp, { source: "grouped-backlinks" }),
	propertySchemasFacet.of(groupedBacklinksOverridesProp, { source: "grouped-backlinks" }),
	propertySchemasFacet.of(groupWithProp, { source: "grouped-backlinks" }),
	queriesFacet.of(groupedBacklinksForBlockQuery, { source: "grouped-backlinks" }),
	...pluginPrefsExtension(groupedBacklinksPrefsType, "grouped-backlinks")
];
//#endregion
export { groupedBacklinksDataExtension };

//# sourceMappingURL=dataExtension.js.map