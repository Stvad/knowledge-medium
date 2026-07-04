import { systemToggle } from "../../facets/togglable.js";
import { extensionsOverridesProp, extensionsPrefsType } from "./config.js";
import { extensionsDataExtension } from "./dataExtension.js";
//#region src/plugins/extensions-settings/index.ts
var extensionsSettingsPlugin = systemToggle({
	id: "system:extensions-settings",
	name: "Extensions (toggle storage)",
	description: "Stores the overrides map and syncs each change into the localStorage cache so toggles take effect across reloads.",
	essential: true
}).of([extensionsDataExtension]);
//#endregion
export { extensionsOverridesProp, extensionsPrefsType, extensionsSettingsPlugin };

//# sourceMappingURL=index.js.map