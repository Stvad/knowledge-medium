import { definePropertyEditorOverride } from "../../data/api/propertySchema.js";
import "../../data/api/index.js";
import { groupedBacklinksDefaultsProp } from "./config.js";
import { GroupedBacklinksDefaultsEditor } from "./GroupedBacklinksConfigEditor.js";
//#region src/plugins/grouped-backlinks/propertyEditorOverride.ts
var groupedBacklinksDefaultsUi = definePropertyEditorOverride({
	name: groupedBacklinksDefaultsProp.name,
	label: "Grouped backlinks defaults",
	Editor: GroupedBacklinksDefaultsEditor
});
//#endregion
export { groupedBacklinksDefaultsUi };

//# sourceMappingURL=propertyEditorOverride.js.map