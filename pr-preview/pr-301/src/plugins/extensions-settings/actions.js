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
var openExtensionsSettingsAction = {
	id: "open_extensions_settings",
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
export { openExtensionsSettingsAction };

//# sourceMappingURL=actions.js.map