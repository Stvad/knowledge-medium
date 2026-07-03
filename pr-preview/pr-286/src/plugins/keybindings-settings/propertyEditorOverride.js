import { definePropertyEditorOverride } from "../../data/api/propertySchema.js";
import "../../data/api/index.js";
import { keybindingOverridesProp } from "./config.js";
import { KeybindingsEditor } from "./KeybindingsEditor.js";
import { createElement } from "react";
//#region src/plugins/keybindings-settings/propertyEditorOverride.ts
var KeybindingsEditorEntry = (props) => createElement(KeybindingsEditor, props);
var keybindingsOverridesUi = definePropertyEditorOverride({
	name: keybindingOverridesProp.name,
	label: "Keyboard shortcuts",
	Editor: KeybindingsEditorEntry
});
//#endregion
export { keybindingsOverridesUi };

//# sourceMappingURL=propertyEditorOverride.js.map