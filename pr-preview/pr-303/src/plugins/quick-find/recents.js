import { defineBlockType } from "../../data/api/blockType.js";
import { ChangeScope } from "../../data/api/changeScope.js";
import { codecs } from "../../data/api/codecs.js";
import { defineProperty } from "../../data/api/propertySchema.js";
import "../../data/api/index.js";
import { getPluginUIStateBlock } from "../../data/stateBlocks.js";
//#region src/plugins/quick-find/recents.ts
var RECENT_BLOCKS_LIMIT = 10;
/** Recently-opened block-id MRU list. Per-device state — what *this*
*  device's user has just been looking at. Lives on the plugin's
*  ui-state sub-block (see `quickFindUIStateType`), scoped to UiState
*  so it stays in its own undo bucket. The sub-block has a deterministic
*  id derived from (workspace, user), so if it does sync the per-device
*  semantic still holds — each device's quick-find subtree is keyed
*  to that device's user identity. */
var recentBlockIdsProp = defineProperty("recentBlockIds", {
	codec: codecs.list(codecs.string),
	defaultValue: [],
	changeScope: ChangeScope.UiState
});
var quickFindUIStateType = defineBlockType({
	id: "quick-find-ui-state",
	label: "Quick find",
	properties: [recentBlockIdsProp]
});
var pushRecentBlockId = (uiStateBlock, blockId) => {
	const next = [blockId, ...(uiStateBlock.peekProperty(recentBlockIdsProp) ?? []).filter((id) => id !== blockId)].slice(0, 10);
	uiStateBlock.set(recentBlockIdsProp, next);
};
/** Read the MRU from anywhere with a `Repo` — autocomplete sources
*  (editor extensions, link-target searches) live outside the QuickFind
*  React tree but need the same recency signal to rank candidates. The
*  ui-state sub-block is resolved through the same memoized helper
*  QuickFind itself uses, so subsequent reads are O(1). Returns `[]` if
*  the sub-block hasn't been initialized yet (first-run before any
*  navigation). */
var loadRecentBlockIds = async (repo, workspaceId) => {
	if (!workspaceId) return [];
	try {
		return (await getPluginUIStateBlock(repo, workspaceId, repo.user, quickFindUIStateType)).peekProperty(recentBlockIdsProp) ?? [];
	} catch {
		return [];
	}
};
//#endregion
export { RECENT_BLOCKS_LIMIT, loadRecentBlockIds, pushRecentBlockId, quickFindUIStateType, recentBlockIdsProp };

//# sourceMappingURL=recents.js.map