import { definePropertyEditorOverride } from "../../data/api/propertySchema.js";
import "../../data/api/index.js";
import { extensionsOverridesProp } from "./config.js";
import { ExtensionsOverridesEditor } from "./ExtensionsOverridesEditor.js";
import { createElement } from "react";
//#region src/plugins/extensions-settings/propertyEditorOverride.ts
var ExtensionsOverridesEditorEntry = (props) => createElement(ExtensionsOverridesEditor, props);
var extensionsOverridesUi = definePropertyEditorOverride({
	name: extensionsOverridesProp.name,
	label: "Extensions",
	Editor: ExtensionsOverridesEditorEntry
});
//#endregion
export { extensionsOverridesUi };

//# sourceMappingURL=propertyEditorOverride.js.map