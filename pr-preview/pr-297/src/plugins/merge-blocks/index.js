import { systemToggle } from "../../facets/togglable.js";
import { actionsFacet } from "../../extensions/core.js";
import { dialogAppMountExtension } from "../../extensions/dialogAppMount.js";
import { MergePicker } from "./MergePicker.js";
import { MERGE_INTO_ACTION_ID, mergeIntoAction } from "./mergeAction.js";
//#region src/plugins/merge-blocks/index.ts
/**
* merge-blocks plugin — adds a "Merge into…" command-palette action on
* any focused block. The action opens a picker that searches link
* targets in the current workspace; on selection, `core.merge` folds
* the source into the picked target. Content strategy (concat vs.
* keepTarget) is decided at commit time by `pickMergeContentStrategy`
* based on the two blocks' types.
*
* Composition:
*   - `MergePicker.tsx`      — modal opened on demand via `openDialog`
*   - `mergeAction.ts`       — block-context action that opens the picker
*/
var mergeBlocksPlugin = systemToggle({
	id: "system:merge-blocks",
	name: "Merge blocks",
	description: "Block-merge actions (Backspace at start of a block merges into the previous one)."
}).of([dialogAppMountExtension, actionsFacet.of(mergeIntoAction, { source: "merge-blocks" })]);
//#endregion
export { MERGE_INTO_ACTION_ID, MergePicker, mergeBlocksPlugin, mergeIntoAction };

//# sourceMappingURL=index.js.map