import { INFRASTRUCTURE_TYPE_DISPLAY } from "./api/blockType.js";
import "./api/index.js";
import { typesFacet } from "./facets.js";
import { LAZY_DEEP_IDLE, scheduleDeepIdle } from "../utils/scheduleIdle.js";
import { appEffectsFacet } from "../extensions/core.js";
import { getPluginPrefsBlock, getPluginUIStateBlock } from "./stateBlocks.js";
//#region src/data/pluginStateExtensions.ts
/** Bundling helpers for plugin-owned prefs / ui-state sub-blocks.
*
*  Each plugin that owns a per-user pref sub-block or a per-device
*  ui-state sub-block declares it as a `TypeContribution` and registers
*  via one of the helpers below. The helpers pair the `typesFacet`
*  registration with an idle-time eager-bootstrap `AppEffect` so the
*  sub-block exists before the user navigates to the Preferences /
*  ui-state tree — without this, plugin sub-blocks would only appear
*  after their hooks run for the first time, making configurable
*  options non-discoverable.
*/
var pluginPrefsBootstrapEffect = (type) => ({
	id: `plugin-prefs.${type.id}.bootstrap`,
	start: ({ repo, workspaceId }) => {
		scheduleDeepIdle(() => {
			getPluginPrefsBlock(repo, workspaceId, repo.user, type);
		}, LAZY_DEEP_IDLE);
	}
});
var pluginUIStateBootstrapEffect = (type) => ({
	id: `plugin-ui-state.${type.id}.bootstrap`,
	start: ({ repo, workspaceId }) => {
		scheduleDeepIdle(() => {
			getPluginUIStateBlock(repo, workspaceId, repo.user, type);
		}, LAZY_DEEP_IDLE);
	}
});
/** Bundle a plugin-prefs `TypeContribution` registration with an
*  idle-time eager-bootstrap effect. Spread the returned array into the
*  plugin's `AppExtension`:
*
*      export const myPlugin: AppExtension = [
*        ...pluginPrefsExtension(myPrefsType, 'my-plugin'),
*        // …other facet contributions…
*      ]
*/
var pluginPrefsExtension = (type, source) => [typesFacet.of({
	...type,
	...INFRASTRUCTURE_TYPE_DISPLAY
}, { source }), appEffectsFacet.of(pluginPrefsBootstrapEffect(type), { source })];
/** Same as `pluginPrefsExtension`, for sub-blocks under the root
*  ui-state subtree (scoped via ChangeScope.UiState — non-undoable but
*  still synced). */
var pluginUIStateExtension = (type, source) => [typesFacet.of({
	...type,
	...INFRASTRUCTURE_TYPE_DISPLAY
}, { source }), appEffectsFacet.of(pluginUIStateBootstrapEffect(type), { source })];
//#endregion
export { pluginPrefsExtension, pluginUIStateExtension };

//# sourceMappingURL=pluginStateExtensions.js.map