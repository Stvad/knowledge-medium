import { systemToggle } from "../../facets/togglable.js";
import { actionsFacet } from "../../extensions/core.js";
import { dialogAppMountExtension } from "../../extensions/dialogAppMount.js";
import { ExtractTypeDialog } from "./ExtractTypeDialog.js";
import { FindTypeInstancesDialog } from "./FindTypeInstancesDialog.js";
import { EXTRACT_TYPE_ACTION_ID, FIND_TYPE_INSTANCES_ACTION_ID, extractTypeAction, findTypeInstancesAction } from "./action.js";
//#region src/plugins/extract-type/index.ts
/** extract-type plugin — UI surface for user-defined-types extraction.
*
*  Contributes:
*   - `extractTypeAction` (NORMAL_MODE) — "Extract type from this
*     block" via the command palette / shortcut binding. Opens
*     `ExtractTypeDialog` through the `openDialog` queue; on submit it
*     creates the type and chains to find-type-instances.
*   - `findTypeInstancesAction` (NORMAL_MODE) — "Find instances of
*     this type." Only surfaces on block-type blocks. Picker for the
*     type's properties with optional value filters → retag candidate
*     confirmation.
*
*  The dialogs are opened imperatively via `openDialog` (rendered by
*  the central DialogHost), so the plugin no longer mounts them. */
var extractTypePlugin = systemToggle({
	id: "system:extract-type",
	name: "Extract type from block",
	description: "Action + dialog that creates a user-defined type from a prototype block: name the type, pick the property subset, confirm matching candidates, retag."
}).of([
	dialogAppMountExtension,
	actionsFacet.of(extractTypeAction, { source: "extract-type" }),
	actionsFacet.of(findTypeInstancesAction, { source: "extract-type" })
]);
//#endregion
export { EXTRACT_TYPE_ACTION_ID, ExtractTypeDialog, FIND_TYPE_INSTANCES_ACTION_ID, FindTypeInstancesDialog, extractTypeAction, extractTypePlugin, findTypeInstancesAction };

//# sourceMappingURL=index.js.map