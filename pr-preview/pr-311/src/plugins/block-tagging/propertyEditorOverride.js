import { definePropertyEditorOverride } from "../../data/api/propertySchema.js";
import "../../data/api/index.js";
import { blockTagsConfigProp } from "./config.js";
import { BlockTagsConfigEditor } from "./BlockTagsConfigEditor.js";
//#region src/plugins/block-tagging/propertyEditorOverride.ts
var blockTagsConfigUi = definePropertyEditorOverride({
	name: blockTagsConfigProp.name,
	label: "Block tags",
	Editor: BlockTagsConfigEditor
});
//#endregion
export { blockTagsConfigUi };

//# sourceMappingURL=propertyEditorOverride.js.map