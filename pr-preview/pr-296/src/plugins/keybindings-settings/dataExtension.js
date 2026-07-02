import { propertyEditorOverridesFacet, propertySchemasFacet } from "../../data/facets.js";
import { actionsFacet, appEffectsFacet } from "../../extensions/core.js";
import { pluginPrefsExtension } from "../../data/pluginStateExtensions.js";
import { keybindingOverridesProp, keybindingsPrefsType } from "./config.js";
import { openKeybindingsSettingsAction } from "./actions.js";
import { keybindingsSyncEffect } from "./effect.js";
import { keybindingsOverridesUi } from "./propertyEditorOverride.js";
//#region src/plugins/keybindings-settings/dataExtension.ts
var keybindingsSettingsDataExtension = [
	propertySchemasFacet.of(keybindingOverridesProp, { source: "keybindings-settings" }),
	propertyEditorOverridesFacet.of(keybindingsOverridesUi, { source: "keybindings-settings" }),
	...pluginPrefsExtension(keybindingsPrefsType, "keybindings-settings"),
	appEffectsFacet.of(keybindingsSyncEffect, { source: "keybindings-settings" }),
	actionsFacet.of(openKeybindingsSettingsAction, { source: "keybindings-settings" })
];
//#endregion
export { keybindingsSettingsDataExtension };

//# sourceMappingURL=dataExtension.js.map