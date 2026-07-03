import { defineBlockType } from "../../data/api/blockType.js";
import { ChangeScope } from "../../data/api/changeScope.js";
import { defineProperty } from "../../data/api/propertySchema.js";
import "../../data/api/index.js";
import { hasBlockType } from "../../data/properties.js";
import { mergeBacklinksFilters, normalizeBacklinksFilter } from "./query.js";
import { EMPTY_BACKLINKS_FILTER, backlinksFilterCodec } from "./filterProperty.js";
import "../daily-notes/schema.js";
//#region src/plugins/backlinks/dailyNoteDefaults.ts
var INITIAL_DAILY_NOTE_BACKLINKS_DEFAULTS = EMPTY_BACKLINKS_FILTER;
var dailyNoteBacklinksDefaultsProp = defineProperty("dailyNotes:backlinksPredicates", {
	codec: backlinksFilterCodec,
	defaultValue: EMPTY_BACKLINKS_FILTER,
	changeScope: ChangeScope.UserPrefs
});
/** Per-plugin prefs sub-block for the backlinks plugin. Currently holds
*  only the daily-note backlinks default filter; per-block filters live
*  on the target block itself (`backlinksFilterProp`, BlockDefault scope). */
var backlinksPrefsType = defineBlockType({
	id: "backlinks-prefs",
	label: "Backlinks",
	properties: [dailyNoteBacklinksDefaultsProp]
});
var isDailyNoteBlockData = (data) => Boolean(data && hasBlockType(data, "daily-note"));
var defaultBacklinksFilterForBlock = (data, dailyNoteDefaults) => isDailyNoteBlockData(data) ? normalizeBacklinksFilter(dailyNoteDefaults) : EMPTY_BACKLINKS_FILTER;
var effectiveBacklinksFilterForBlock = (data, localFilter, dailyNoteDefaults) => isDailyNoteBlockData(data) ? mergeBacklinksFilters(dailyNoteDefaults, localFilter) : normalizeBacklinksFilter(localFilter);
//#endregion
export { INITIAL_DAILY_NOTE_BACKLINKS_DEFAULTS, backlinksPrefsType, dailyNoteBacklinksDefaultsProp, defaultBacklinksFilterForBlock, effectiveBacklinksFilterForBlock, isDailyNoteBlockData };

//# sourceMappingURL=dailyNoteDefaults.js.map