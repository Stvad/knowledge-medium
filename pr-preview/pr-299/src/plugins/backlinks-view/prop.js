import { ChangeScope } from "../../data/api/changeScope.js";
import { codecs } from "../../data/api/codecs.js";
import { defineProperty } from "../../data/api/propertySchema.js";
import "../../data/api/index.js";
import { hasBlockType } from "../../data/properties.js";
import "../daily-notes/schema.js";
//#region src/plugins/backlinks-view/prop.ts
var FLAT_BACKLINKS_VIEW_ID = "flat";
var GROUPED_BACKLINKS_VIEW_ID = "grouped";
var DEFAULT_BACKLINKS_VIEW_ID = FLAT_BACKLINKS_VIEW_ID;
var defaultBacklinksViewIdForBlock = (data) => data && hasBlockType(data, "daily-note") ? GROUPED_BACKLINKS_VIEW_ID : FLAT_BACKLINKS_VIEW_ID;
/** Optional per-block backlinks-view variant override. When unset, the
*  coordinator derives the view from the target block: grouped for
*  daily-note pages, flat otherwise. */
var backlinksViewProp = defineProperty("backlinks:viewId", {
	codec: codecs.optionalString,
	defaultValue: void 0,
	changeScope: ChangeScope.BlockDefault
});
//#endregion
export { DEFAULT_BACKLINKS_VIEW_ID, FLAT_BACKLINKS_VIEW_ID, GROUPED_BACKLINKS_VIEW_ID, backlinksViewProp, defaultBacklinksViewIdForBlock };

//# sourceMappingURL=prop.js.map