import { MergeIntoDescendantError } from "./api/errors.js";
import { CORE_BLOCK_MERGED_EVENT } from "./api/events.js";
import "./api/index.js";
import { keysBetween } from "./orderKey.js";
import { mergeProperties } from "./mergeProperties.js";
//#region src/data/blockMerge.ts
var computeMergedContent = (intoContent, fromContent, strategy) => {
	if (strategy === "concat") return intoContent + fromContent;
	if (strategy === "keepTarget") return intoContent.length > 0 ? intoContent : fromContent;
	return intoContent + strategy.separator + fromContent;
};
var mergeBlocksInTx = async (tx, { into, from, contentStrategy = "concat", mergeProperties: mergeProps = mergeProperties, aliasRewrites = [] }) => {
	if (into.id === from.id) return;
	if (await tx.isDescendantOf(into.id, from.id)) throw new MergeIntoDescendantError(into.id, from.id);
	const intoChildren = await tx.childrenOf(into.id);
	const fromChildren = await tx.childrenOf(from.id);
	if (fromChildren.length > 0) {
		const keys = keysBetween(intoChildren.at(-1)?.orderKey ?? null, null, fromChildren.length);
		for (let i = 0; i < fromChildren.length; i++) await tx.move(fromChildren[i].id, {
			parentId: into.id,
			orderKey: keys[i]
		});
	}
	await tx.delete(from.id);
	await tx.update(into.id, {
		content: computeMergedContent(into.content, from.content, contentStrategy),
		properties: mergeProps(into.properties, from.properties)
	});
	tx.emitEvent(CORE_BLOCK_MERGED_EVENT, {
		workspaceId: from.workspaceId,
		fromId: from.id,
		intoId: into.id,
		aliasRewrites: [...aliasRewrites]
	});
};
//#endregion
export { computeMergedContent, mergeBlocksInTx };

//# sourceMappingURL=blockMerge.js.map