import { propertyEditorOverridesFacet, propertySchemasFacet } from "../../data/facets.js";
import { actionsFacet, appEffectsFacet } from "../../extensions/core.js";
import { pluginPrefsExtension } from "../../data/pluginStateExtensions.js";
import { extensionsOverridesProp, extensionsPrefsType } from "./config.js";
import { openExtensionsSettingsAction } from "./actions.js";
import { extensionsSyncEffect } from "./effect.js";
import { extensionsOverridesUi } from "./propertyEditorOverride.js";
//#region src/plugins/extensions-settings/dataExtension.ts
/**
* Extensions meta-plugin data registrations.
*
*   - `propertySchemasFacet` registers the overrides codec so the
*     property reads/writes go through the strict decoder.
*   - `pluginPrefsExtension` bundles the `typesFacet` registration
*     for the prefs sub-block with an idle-time eager bootstrap.
*     The bootstrap creates the block before the user navigates to
*     Preferences, so its existence isn't gated on opening the
*     settings UI.
*   - `extensionsSyncEffect` subscribes to the block, mirrors
*     each change into the localStorage cache, and dispatches
*     `refreshAppRuntime` whenever the canonical state diverges.
*   - `propertyEditorOverridesFacet` registers the custom checkbox-
*     tree editor that renders inside the prefs block's property
*     panel — this is the actual settings UI surface.
*   - `actionsFacet` exposes "Manage extensions" in the command
*     palette; the handler just navigates to the prefs block in a
*     new panel.
*/
var extensionsDataExtension = [
	propertySchemasFacet.of(extensionsOverridesProp, { source: "extensions-settings" }),
	propertyEditorOverridesFacet.of(extensionsOverridesUi, { source: "extensions-settings" }),
	...pluginPrefsExtension(extensionsPrefsType, "extensions-settings"),
	appEffectsFacet.of(extensionsSyncEffect, { source: "extensions-settings" }),
	actionsFacet.of(openExtensionsSettingsAction, { source: "extensions-settings" })
];
//#endregion
export { extensionsDataExtension };

//# sourceMappingURL=dataExtension.js.map