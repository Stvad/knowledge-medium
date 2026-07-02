import { defineBlockType } from "../../data/api/blockType.js";
import { ChangeScope } from "../../data/api/changeScope.js";
import { codecs } from "../../data/api/codecs.js";
import { defineProperty } from "../../data/api/propertySchema.js";
import "../../data/api/index.js";
import { aliasesProp } from "../../data/properties.js";
//#region src/plugins/daily-notes/schema.ts
var DAILY_NOTE_TYPE = "daily-note";
/** Indexable calendar-day value for a daily-note page. Lets the query
*  layer resolve ref-typed properties that point at daily notes
*  (e.g. SRS's `next-review-date`) as comparable dates without
*  parsing aliases at query time. Populated at write by
*  `getOrCreateDailyNote` / `ensureDailyNoteTarget` and backfilled
*  once per device from the ISO alias for pre-existing rows. */
var dailyNoteDateProp = defineProperty("daily-note:date", {
	codec: codecs.date,
	defaultValue: void 0,
	changeScope: ChangeScope.BlockDefault
});
var dailyNoteType = defineBlockType({
	id: DAILY_NOTE_TYPE,
	label: "Daily note",
	properties: [aliasesProp, dailyNoteDateProp]
});
//#endregion
export { DAILY_NOTE_TYPE, dailyNoteDateProp, dailyNoteType };

//# sourceMappingURL=schema.js.map