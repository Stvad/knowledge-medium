import { Combine } from "../../../node_modules/lucide-react/dist/esm/icons/combine.js";
import { ActionContextTypes } from "../../shortcuts/types.js";
import { openDialog } from "../../utils/dialogs.js";
import { MergePicker } from "./MergePicker.js";
//#region src/plugins/merge-blocks/mergeAction.ts
/**
* "Merge into…" block action — opens the merge-target picker over the
* focused block. Source = the focused block (the one that disappears);
* target = whatever the user picks in the modal. Strategy (`'concat'`
* vs `'keepTarget'`) is decided at commit time by `pickMergeContentStrategy`
* looking at the two blocks' types, so the kernel mutator stays
* policy-free (see `core.merge`).
*
* Visible for any block (no `isVisible` gate) per the design discussion:
* for outline blocks the user gets a concat-style merge they could've
* gotten with Backspace; for pages they get the type-aware page merge.
*/
var MERGE_INTO_ACTION_ID = "merge_blocks.merge_into";
var mergeIntoAction = {
	id: MERGE_INTO_ACTION_ID,
	description: "Merge into…",
	context: ActionContextTypes.NORMAL_MODE,
	icon: Combine,
	handler: async ({ block }) => {
		const data = block.peek() ?? await block.load();
		if (!data) return;
		openDialog(MergePicker, {
			sourceBlockId: block.id,
			workspaceId: data.workspaceId
		});
	}
};
//#endregion
export { MERGE_INTO_ACTION_ID, mergeIntoAction };

//# sourceMappingURL=mergeAction.js.map