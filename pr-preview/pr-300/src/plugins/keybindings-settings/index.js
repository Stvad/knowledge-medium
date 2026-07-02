import { systemToggle } from "../../facets/togglable.js";
import { keybindingOverridesProp, keybindingsPrefsType } from "./config.js";
import { keybindingsSettingsDataExtension } from "./dataExtension.js";
//#region src/plugins/keybindings-settings/index.ts
var keybindingsSettingsPlugin = systemToggle({
	id: "system:keybindings-settings",
	name: "Keyboard shortcuts",
	description: "Lets you remap any action’s keyboard shortcut. Stores overrides on a per-user prefs block.",
	essential: true
}).of([keybindingsSettingsDataExtension]);
//#endregion
export { keybindingOverridesProp, keybindingsPrefsType, keybindingsSettingsPlugin };

//# sourceMappingURL=index.js.map