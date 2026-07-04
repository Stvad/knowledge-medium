import { selectionStateProp } from "../data/properties.js";
//#region src/utils/copy.ts
var createIndentedContent = (content, depth) => {
	const indentBy = "  ";
	const indentation = depth > 0 ? indentBy.repeat(depth) : "";
	return `${indentation}- ${content.split("\n").join("\n" + indentation + indentBy)}`;
};
var serializeBlock = async (block) => {
	const blocks = await block.repo.query.subtree({ id: block.id }).load();
	if (blocks.length === 0) throw new Error(`No block data could be serialized for block with id ${block.id}`);
	if (blocks.length === 1) return {
		markdown: blocks[0].content,
		blocks
	};
	return {
		markdown: blocks.map((b) => createIndentedContent(b.content, b.depth)).join("\n"),
		blocks
	};
};
var createClipboardItem = (data) => new ClipboardItem({ "text/plain": new Blob([data.markdown], { type: "text/plain" }) });
var writeToClipboard = async (data) => navigator.clipboard.write([createClipboardItem(data)]);
var copyBlockToClipboard = async (block) => writeToClipboard(await serializeBlock(block));
var getSelectionState = (uiStateBlock) => uiStateBlock.peekProperty(selectionStateProp);
var serializeSelectedBlocks = async (blockIds, repo) => {
	const validResults = (await Promise.all(blockIds.map((id) => repo.block(id)).map(async (block) => {
		try {
			return await serializeBlock(block);
		} catch (error) {
			console.error(`Failed to serialize block ${block.id}:`, error);
			return null;
		}
	}))).filter((result) => result !== null);
	if (validResults.length === 0) throw new Error("No block data could be serialized for copying");
	return {
		markdown: validResults.map((r) => r.markdown).join("\n"),
		blocks: validResults.flatMap((r) => r.blocks)
	};
};
var copySelectedBlocksToClipboard = async (uiStateBlock, repo) => {
	if (!uiStateBlock || !repo) return;
	const selectionState = getSelectionState(uiStateBlock);
	if (!selectionState?.selectedBlockIds?.length) {
		console.log("No blocks selected to copy");
		return;
	}
	await writeToClipboard(await serializeSelectedBlocks(selectionState.selectedBlockIds, repo));
};
//#endregion
export { copyBlockToClipboard, copySelectedBlocksToClipboard, serializeBlock, serializeSelectedBlocks };

//# sourceMappingURL=copy.js.map