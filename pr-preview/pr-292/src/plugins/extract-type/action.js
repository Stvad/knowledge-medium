import { getBlockTypes } from "../../data/properties.js";
import "../../data/blockTypes.js";
import { Sparkles } from "../../../node_modules/lucide-react/dist/esm/icons/sparkles.js";
import { Users } from "../../../node_modules/lucide-react/dist/esm/icons/users.js";
import { ActionContextTypes } from "../../shortcuts/types.js";
import { openDialog } from "../../utils/dialogs.js";
import { ExtractTypeDialog } from "./ExtractTypeDialog.js";
import { FindTypeInstancesDialog } from "./FindTypeInstancesDialog.js";
//#region src/plugins/extract-type/action.ts
/** NORMAL_MODE actions wired around the typeExtraction primitives:
*
*   - `extractTypeAction` — opens the extract-type dialog: name +
*     property subset → create the type, then delegate to
*     `findTypeInstancesAction` on the new type to find candidates
*     to retag.
*   - `findTypeInstancesAction` — "Find block candidates for this
*     type." Opens the find-blocks-to-retag dialog: pick a subset of
*     the type's properties (optionally with value filters) and retag
*     matching blocks. Only surfaces on block-type blocks.
*
*  Each handler opens its dialog through the promise-returning
*  `openDialog` queue. `extractType` chains: it awaits the new type id
*  from `ExtractTypeDialog`, then opens `FindTypeInstancesDialog` on
*  it. */
var EXTRACT_TYPE_ACTION_ID = "block.extract_type";
var extractTypeAction = {
	id: EXTRACT_TYPE_ACTION_ID,
	description: "Extract type from this block",
	context: ActionContextTypes.NORMAL_MODE,
	icon: Sparkles,
	handler: async ({ block }) => {
		const created = await openDialog(ExtractTypeDialog, { prototypeBlockId: block.id });
		if (!created) return;
		await openDialog(FindTypeInstancesDialog, { typeBlockId: created.typeBlockId });
	}
};
var FIND_TYPE_INSTANCES_ACTION_ID = "block.find_type_instances";
var findTypeInstancesAction = {
	id: FIND_TYPE_INSTANCES_ACTION_ID,
	description: "Find block candidates for this type",
	context: ActionContextTypes.NORMAL_MODE,
	icon: Users,
	isVisible: ({ block }) => {
		const data = block.peek();
		return !!data && getBlockTypes(data).includes("block-type");
	},
	handler: ({ block }) => {
		openDialog(FindTypeInstancesDialog, { typeBlockId: block.id });
	}
};
//#endregion
export { EXTRACT_TYPE_ACTION_ID, FIND_TYPE_INSTANCES_ACTION_ID, extractTypeAction, findTypeInstancesAction };

//# sourceMappingURL=action.js.map