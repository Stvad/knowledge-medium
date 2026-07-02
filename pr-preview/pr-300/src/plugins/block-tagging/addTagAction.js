import { showError, showSuccess } from "../../utils/toast.js";
import { Tag } from "../../../node_modules/lucide-react/dist/esm/icons/tag.js";
import { defineBlocksAction } from "../../shortcuts/utils.js";
import { openDialog } from "../../utils/dialogs.js";
import { AddTagDialog } from "./AddTagDialog.js";
import { appendTagToBlocks } from "./appendTag.js";
//#region src/plugins/block-tagging/addTagAction.ts
var ADD_TAG_ACTION_ID = "block-tagging.add-tag";
/** Pick a tag (one dialog per invocation) and append it to every
*  block in `blocks`. Used by both context variants — the dialog
*  opens exactly once regardless of how many blocks are being
*  tagged. */
var runAddTagFlow = async (blocks) => {
	if (blocks.length === 0) return;
	const choice = await openDialog(AddTagDialog);
	if (!choice) return;
	try {
		const result = await appendTagToBlocks(blocks, choice.tagName);
		if (result.updated > 0) showSuccess(`Tagged ${result.updated} block${result.updated === 1 ? "" : "s"} with [[${choice.tagName}]]`);
		else if (result.alreadyTagged > 0) showError(`Every selected block already carries [[${choice.tagName}]]`);
		else showError("No blocks were tagged");
	} catch (error) {
		showError(error instanceof Error ? error.message : "Failed to tag blocks");
	}
};
var pair = defineBlocksAction({
	id: ADD_TAG_ACTION_ID,
	icon: Tag,
	blockDescription: "Tag block",
	blocksDescription: "Tag selected blocks",
	flow: runAddTagFlow
});
var addTagBlockAction = pair.block;
var addTagAction = pair.blocks;
var ADD_TAG_BLOCKS_ACTION_ID = pair.blocks.id;
var addTagGroupHeaderEntry = { actionId: pair.blocks.id };
//#endregion
export { ADD_TAG_ACTION_ID, ADD_TAG_BLOCKS_ACTION_ID, addTagAction, addTagBlockAction, addTagGroupHeaderEntry };

//# sourceMappingURL=addTagAction.js.map