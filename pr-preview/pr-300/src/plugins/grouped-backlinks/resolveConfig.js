import { getPluginPrefsBlock } from "../../data/stateBlocks.js";
import { EMPTY_GROUPED_BACKLINKS_CONFIG, groupedBacklinksDefaultsProp, groupedBacklinksPrefsType, mergeGroupedBacklinksConfig, normalizeGroupedBacklinksConfig, selectGroupedBacklinksOverrides } from "./config.js";
//#region src/plugins/grouped-backlinks/resolveConfig.ts
/** Resolve the grouping config for `blockId` the way the grouped-backlinks
*  view does, but outside React. The `'user'` branch bootstraps the
*  grouped-backlinks user-prefs sub-block on first access (same as
*  opening the panel in-app does). */
var resolveGroupedBacklinksConfig = async (repo, workspaceId, blockId, spec = "user") => {
	if (spec && typeof spec === "object") return normalizeGroupedBacklinksConfig(spec);
	if (spec === "none") return EMPTY_GROUPED_BACKLINKS_CONFIG;
	return mergeGroupedBacklinksConfig((await getPluginPrefsBlock(repo, workspaceId, repo.user, groupedBacklinksPrefsType)).peekProperty(groupedBacklinksDefaultsProp) ?? groupedBacklinksDefaultsProp.defaultValue, selectGroupedBacklinksOverrides(await repo.load(blockId)));
};
//#endregion
export { resolveGroupedBacklinksConfig };

//# sourceMappingURL=resolveConfig.js.map