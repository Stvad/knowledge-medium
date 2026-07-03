import { getPluginPrefsBlock } from "../../data/stateBlocks.js";
import { refreshAppRuntime } from "../../facets/runtimeEvents.js";
import { readOverridesCache, writeOverridesCache } from "../../extensions/overridesCache.js";
import { extensionsOverridesProp, extensionsPrefsType } from "./config.js";
//#region src/plugins/extensions-settings/effect.ts
var overridesEqual = (a, b) => {
	if (a.size !== b.size) return false;
	for (const [id, state] of a) if (b.get(id) !== state) return false;
	return true;
};
/** Read the overrides map from a Block snapshot. Returns an empty map
*  on codec failure (malformed property) and logs the error rather
*  than letting it bubble — taking down extensions because the
*  config block is corrupt would defeat the purpose of having a
*  toggle system. */
var readOverridesFromBlock = (block) => {
	try {
		return block.peekProperty(extensionsOverridesProp) ?? /* @__PURE__ */ new Map();
	} catch (error) {
		console.error("Extensions: overrides property is malformed; falling back to no overrides. Repair via settings or manually edit the Extensions block.", error);
		return /* @__PURE__ */ new Map();
	}
};
/** Pure reconcile step — compares the block's overrides against the
*  cached map, writes + dispatches refresh when they differ.
*  Extracted so tests can drive it without constructing a Block /
*  Repo. Returns `true` when a refresh was dispatched. */
var reconcileOverrides = (workspaceId, block, dispatchRefresh = refreshAppRuntime) => {
	const next = readOverridesFromBlock(block);
	if (overridesEqual(next, readOverridesCache(workspaceId))) return false;
	writeOverridesCache(workspaceId, next);
	dispatchRefresh();
	return true;
};
var extensionsSyncEffect = {
	id: "extensions.sync-cache",
	start: ({ repo, workspaceId }) => {
		let disposed = false;
		let unsubscribe;
		(async () => {
			const block = await getPluginPrefsBlock(repo, workspaceId, repo.user, extensionsPrefsType);
			if (disposed) return;
			const reconcile = () => reconcileOverrides(workspaceId, block);
			reconcile();
			unsubscribe = block.subscribe(reconcile);
		})().catch((error) => {
			console.error("Extensions: failed to resolve prefs block; overrides will not sync until next session.", error);
		});
		return () => {
			disposed = true;
			unsubscribe?.();
		};
	}
};
//#endregion
export { extensionsSyncEffect, overridesEqual, readOverridesFromBlock, reconcileOverrides };

//# sourceMappingURL=effect.js.map