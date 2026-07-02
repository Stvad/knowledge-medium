import { propertySchemasFacet } from "../../data/facets.js";
import { pluginPrefsExtension } from "../../data/pluginStateExtensions.js";
import { blockTaggingPrefsType, blockTagsConfigProp } from "./config.js";
//#region src/plugins/block-tagging/dataExtension.ts
var blockTaggingDataExtension = [propertySchemasFacet.of(blockTagsConfigProp, { source: "block-tagging" }), ...pluginPrefsExtension(blockTaggingPrefsType, "block-tagging")];
//#endregion
export { blockTaggingDataExtension };

//# sourceMappingURL=dataExtension.js.map