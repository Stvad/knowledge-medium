import { localSchemaFacet, refTargetFilterDefaultsFacet, systemPagesFacet, typesFacet, workspaceBackfillsFacet } from "../../data/facets.js";
import { DAILY_NOTE_TYPE, dailyNoteDateProp, dailyNoteType } from "./schema.js";
import { getOrCreateJournalBlock } from "./dailyNotes.js";
import { dailyNoteDateBackfill } from "./backfill.js";
import { dailyNotesLocalSchema } from "./localSchema.js";
//#region src/plugins/daily-notes/dataExtension.ts
var dailyNotesDataExtension = [
	typesFacet.of(dailyNoteType, { source: "daily-notes" }),
	localSchemaFacet.of(dailyNotesLocalSchema, { source: "daily-notes" }),
	workspaceBackfillsFacet.of(dailyNoteDateBackfill, { source: "daily-notes" }),
	systemPagesFacet.of({
		id: "daily-notes:journal",
		ensure: getOrCreateJournalBlock
	}, { source: "daily-notes" }),
	refTargetFilterDefaultsFacet.of({
		targetType: DAILY_NOTE_TYPE,
		property: dailyNoteDateProp.name
	}, { source: "daily-notes" })
];
//#endregion
export { dailyNotesDataExtension };

//# sourceMappingURL=dataExtension.js.map