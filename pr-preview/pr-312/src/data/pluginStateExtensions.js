import { typesFacet } from "./facets.js";
import { LAZY_DEEP_IDLE, scheduleDeepIdle } from "../utils/scheduleIdle.js";
import { appEffectsFacet } from "../extensions/core.js";
import { getPluginPrefsBlock, getPluginUIStateBlock } from "./stateBlocks.js";
//#region src/data/pluginStateExtensions.ts
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
	hideFromCompletion: true
}, { source }), appEffectsFacet.of(pluginPrefsBootstrapEffect(type), { source })];
/** Same as `pluginPrefsExtension`, for sub-blocks under the root
*  ui-state subtree (scoped via ChangeScope.UiState — non-undoable but
*  still synced). */
var pluginUIStateExtension = (type, source) => [typesFacet.of({
	...type,
	hideFromCompletion: true
}, { source }), appEffectsFacet.of(pluginUIStateBootstrapEffect(type), { source })];
//#endregion
export { pluginPrefsExtension, pluginUIStateExtension };

//# sourceMappingURL=pluginStateExtensions.js.map