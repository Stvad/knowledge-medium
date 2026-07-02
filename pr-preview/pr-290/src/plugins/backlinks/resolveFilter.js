import { getPluginPrefsBlock } from "../../data/stateBlocks.js";
import { hasBacklinksFilter, normalizeBacklinksFilter } from "./query.js";
import { backlinksFilterProp, readBacklinksFilterProperty } from "./filterProperty.js";
import { backlinksPrefsType, dailyNoteBacklinksDefaultsProp, effectiveBacklinksFilterForBlock } from "./dailyNoteDefaults.js";
//#region src/plugins/backlinks/resolveFilter.ts
/** Resolve a `BacklinksFilter` (or `undefined` for "no filter") for
*  `blockId`. Returns `undefined` whenever the resolved filter is empty
*  so callers can skip passing it to the query. The `'effective'` branch
*  bootstraps the backlinks user-prefs sub-block (same as the panel). */
var resolveBacklinksFilter = async (repo, workspaceId, blockId, spec = "none") => {
	if (spec && typeof spec === "object") {
		const normalized = normalizeBacklinksFilter(spec);
		return hasBacklinksFilter(normalized) ? normalized : void 0;
	}
	if (spec === "none") return void 0;
	const blockData = await repo.load(blockId);
	const stored = readBacklinksFilterProperty(blockData?.properties?.[backlinksFilterProp.name]);
	if (spec === "stored") return hasBacklinksFilter(stored) ? stored : void 0;
	const effective = effectiveBacklinksFilterForBlock(blockData, stored, (await getPluginPrefsBlock(repo, workspaceId, repo.user, backlinksPrefsType)).peekProperty(dailyNoteBacklinksDefaultsProp) ?? dailyNoteBacklinksDefaultsProp.defaultValue);
	return hasBacklinksFilter(effective) ? effective : void 0;
};
//#endregion
export { resolveBacklinksFilter };

//# sourceMappingURL=resolveFilter.js.map