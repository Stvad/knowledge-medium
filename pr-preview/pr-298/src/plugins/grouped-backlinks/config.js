import { defineBlockType } from "../../data/api/blockType.js";
import { ChangeScope } from "../../data/api/changeScope.js";
import { codecs } from "../../data/api/codecs.js";
import { defineProperty } from "../../data/api/propertySchema.js";
import "../../data/api/index.js";
import { uniqueStrings } from "../../utils/array.js";
//#region src/plugins/grouped-backlinks/config.ts
var EMPTY_GROUPED_BACKLINKS_CONFIG = {
	highPriorityTags: [],
	lowPriorityTags: [],
	excludedTags: [],
	excludedPatterns: []
};
var EMPTY_GROUPED_BACKLINKS_OVERRIDES = {};
var INITIAL_GROUPED_BACKLINKS_CONFIG = {
	highPriorityTags: [],
	lowPriorityTags: [
		"reflection",
		"task",
		"weekly review",
		"person"
	],
	excludedTags: [
		"ptr",
		"otter.ai/transcript",
		"otter.ai",
		"TODO",
		"DONE",
		"factor",
		"interval",
		"isa",
		"repeat interval",
		"make-public",
		"matrix-messages",
		"page",
		"daily-note"
	],
	excludedPatterns: [
		"^\\[\\[factor]]:.+",
		"^\\[\\[interval]]:.+",
		"^\\d{4}-\\d{2}-\\d{2}$",
		"^[A-Z][a-z]+ \\d{1,2}(st|nd|rd|th), \\d{4}$"
	]
};
var stringList = (record, key) => uniqueStrings(record[key]);
var optionalStringList = (record, key) => Object.hasOwn(record, key) ? uniqueStrings(record[key]) : void 0;
var recordFrom = (value) => value && typeof value === "object" && !Array.isArray(value) ? value : {};
var normalizeGroupedBacklinksConfig = (value) => {
	const record = recordFrom(value);
	return {
		highPriorityTags: stringList(record, "highPriorityTags"),
		lowPriorityTags: stringList(record, "lowPriorityTags"),
		excludedTags: stringList(record, "excludedTags"),
		excludedPatterns: stringList(record, "excludedPatterns")
	};
};
var normalizeGroupedBacklinksOverrides = (value) => {
	const record = recordFrom(value);
	return {
		highPriorityTags: optionalStringList(record, "highPriorityTags"),
		lowPriorityTags: optionalStringList(record, "lowPriorityTags"),
		excludedTags: optionalStringList(record, "excludedTags"),
		excludedPatterns: optionalStringList(record, "excludedPatterns")
	};
};
var mergeGroupedBacklinksConfig = (defaults, overrides) => ({
	highPriorityTags: overrides.highPriorityTags ?? defaults.highPriorityTags,
	lowPriorityTags: overrides.lowPriorityTags ?? defaults.lowPriorityTags,
	excludedTags: overrides.excludedTags ?? defaults.excludedTags,
	excludedPatterns: overrides.excludedPatterns ?? defaults.excludedPatterns
});
/** Read a target block's per-block grouping overrides off its decoded
*  block data. Shared by the React hook (`useGroupedBacklinksConfig`)
*  and the non-React resolver (`resolveGroupedBacklinksConfig`) so both
*  read the override property the same way. */
var selectGroupedBacklinksOverrides = (data) => {
	const stored = data?.properties[groupedBacklinksOverridesProp.name];
	return stored === void 0 ? groupedBacklinksOverridesProp.defaultValue : groupedBacklinksOverridesProp.codec.decode(stored);
};
var groupedBacklinksConfigCodec = {
	type: "groupedBacklinks:config",
	encode: normalizeGroupedBacklinksConfig,
	decode: normalizeGroupedBacklinksConfig
};
var groupedBacklinksOverridesCodec = {
	type: "groupedBacklinks:overrides",
	encode: normalizeGroupedBacklinksOverrides,
	decode: normalizeGroupedBacklinksOverrides
};
var groupedBacklinksDefaultsProp = defineProperty("groupedBacklinks:defaults", {
	codec: groupedBacklinksConfigCodec,
	defaultValue: INITIAL_GROUPED_BACKLINKS_CONFIG,
	changeScope: ChangeScope.UserPrefs
});
var groupedBacklinksOverridesProp = defineProperty("groupedBacklinks:overrides", {
	codec: groupedBacklinksOverridesCodec,
	defaultValue: EMPTY_GROUPED_BACKLINKS_OVERRIDES,
	changeScope: ChangeScope.BlockDefault
});
/** Per-plugin prefs sub-block for grouped-backlinks defaults. The
*  defaults live here (UserPrefs scope); per-block overrides keep using
*  `groupedBacklinksOverridesProp` on the target block itself. */
var groupedBacklinksPrefsType = defineBlockType({
	id: "grouped-backlinks-prefs",
	label: "Grouped backlinks",
	properties: [groupedBacklinksDefaultsProp]
});
/** Property name for `groupWith` — set on a block X to say "anything
*  referencing X should also be grouped under [[Y]]". Values are
*  projected into `block_references` with `source_field='groupWith'`
*  (via `projectPropertyReferences`), which the grouped-backlinks
*  query reads to expand each backlink's group set. */
var GROUP_WITH_PROP_NAME = "groupWith";
var groupWithProp = defineProperty(GROUP_WITH_PROP_NAME, {
	codec: codecs.refList(),
	defaultValue: [],
	changeScope: ChangeScope.BlockDefault
});
//#endregion
export { EMPTY_GROUPED_BACKLINKS_CONFIG, GROUP_WITH_PROP_NAME, INITIAL_GROUPED_BACKLINKS_CONFIG, groupWithProp, groupedBacklinksDefaultsProp, groupedBacklinksOverridesProp, groupedBacklinksPrefsType, mergeGroupedBacklinksConfig, normalizeGroupedBacklinksConfig, normalizeGroupedBacklinksOverrides, selectGroupedBacklinksOverrides };

//# sourceMappingURL=config.js.map