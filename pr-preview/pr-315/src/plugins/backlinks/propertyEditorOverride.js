import { definePropertyEditorOverride } from "../../data/api/propertySchema.js";
import "../../data/api/index.js";
import { dailyNoteBacklinksDefaultsProp } from "./dailyNoteDefaults.js";
import { BacklinksFilterPropertyEditor } from "./BacklinksFilterPropertyEditor.js";
//#region src/plugins/backlinks/propertyEditorOverride.ts
var dailyNoteBacklinksDefaultsUi = definePropertyEditorOverride({
	name: dailyNoteBacklinksDefaultsProp.name,
	label: "Daily note backlinks defaults",
	Editor: BacklinksFilterPropertyEditor
});
//#endregion
export { dailyNoteBacklinksDefaultsUi };

//# sourceMappingURL=propertyEditorOverride.js.map