import { ChangeScope } from "../data/api/changeScope.js";
import "../data/api/index.js";
//#region src/utils/state.ts
/** Import a parsed block tree into the repo as one atomic
*  transaction. The input shape is the lightweight `ParsedBlock`
*  produced by markdownParser (or hand-built by tests). The function
*  returns a Map from input id → Block facade.
*
*  Workspace resolution: callers either pass `options.workspaceId`
*  (overrides any per-block value) or rely on `repo.activeWorkspaceId`.
*  No fallback to a synthetic workspace — that papers over bugs. */
var importState = async (state, repo, options = {}) => {
	const blockMap = /* @__PURE__ */ new Map();
	if (state.blocks.length === 0) return blockMap;
	const workspaceId = options.workspaceId ?? repo.activeWorkspaceId;
	if (!workspaceId) throw new Error("importState requires a workspaceId — pass options.workspaceId or call repo.setActiveWorkspaceId() first");
	await repo.tx(async (tx) => {
		for (const block of state.blocks) {
			const id = await tx.create({
				id: block.id,
				workspaceId,
				parentId: block.parentId ?? null,
				orderKey: block.orderKey,
				content: block.content
			});
			blockMap.set(id, repo.block(id));
		}
	}, {
		scope: ChangeScope.BlockDefault,
		description: "importState"
	});
	return blockMap;
};
//#endregion
export { importState };

//# sourceMappingURL=state.js.map