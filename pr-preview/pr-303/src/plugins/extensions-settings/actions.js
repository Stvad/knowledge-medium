import { showPropertiesProp } from "../../data/properties.js";
import { getPluginPrefsBlock } from "../../data/stateBlocks.js";
import { ActionContextTypes } from "../../shortcuts/types.js";
import { navigate } from "../../utils/navigation.js";
import { extensionsPrefsType } from "./config.js";
//#region src/plugins/extensions-settings/actions.ts
/**
* Command-palette / shortcut action for opening the Extensions
* settings. The settings UI itself is a `PropertyEditorOverride`
* registered on `extensionsOverridesProp`, so "opening settings"
* is just navigating to the Extensions prefs block — the block's
* property panel renders the toggle tree.
*
* The action also sets `showPropertiesProp: true` on the block so
* the property panel is visible on arrival. Without this, the user
* lands on a settings block whose content is empty (everything lives
* in properties) and would have to toggle the panel manually.
* Scoped UiState so the choice is per-device and doesn't sync.
*/
/** Stable id for the "Manage extensions" action. Exported so other surfaces
*  (the global extension-prompt indicator) can route to settings via
*  `runActionById` without hardcoding the string. */
var OPEN_EXTENSIONS_SETTINGS_ACTION_ID = "open_extensions_settings";
var openExtensionsSettingsAction = {
	id: OPEN_EXTENSIONS_SETTINGS_ACTION_ID,
	description: "Manage extensions",
	context: ActionContextTypes.GLOBAL,
	handler: async ({ uiStateBlock }) => {
		const repo = uiStateBlock.repo;
		const workspaceId = repo.activeWorkspaceId;
		if (!workspaceId) return;
		const prefsBlock = await getPluginPrefsBlock(repo, workspaceId, repo.user, extensionsPrefsType);
		await prefsBlock.set(showPropertiesProp, true);
		navigate(repo, {
			target: "new-panel",
			blockId: prefsBlock.id,
			workspaceId
		});
	}
};
//#endregion
export { OPEN_EXTENSIONS_SETTINGS_ACTION_ID, openExtensionsSettingsAction };

//# sourceMappingURL=actions.js.map