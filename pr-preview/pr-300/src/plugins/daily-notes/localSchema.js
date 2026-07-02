import { dailyNoteDateProp } from "./schema.js";
//#region src/plugins/daily-notes/localSchema.ts
/** Always-quoted JSON path for the date property. Matches what
*  `jsonPathForProperty` (in the typed-query compiler) emits, so the
*  expression index below uses the same literal text the compiler
*  produces — SQLite only matches expression indexes by literal text. */
var DAILY_NOTE_DATE_JSON_PATH = `$."${dailyNoteDateProp.name}"`;
var dailyNotesLocalSchema = {
	id: "daily-notes.local-schema",
	statements: [`
  CREATE INDEX IF NOT EXISTS idx_blocks_daily_note_date
  ON blocks (json_extract(properties_json, '${DAILY_NOTE_DATE_JSON_PATH}'))
  WHERE deleted = 0
    AND json_extract(properties_json, '${DAILY_NOTE_DATE_JSON_PATH}') IS NOT NULL
`]
};
//#endregion
export { dailyNotesLocalSchema };

//# sourceMappingURL=localSchema.js.map