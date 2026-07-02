import { startCompletion } from "../../../node_modules/@codemirror/autocomplete/dist/index.js";
import { Brackets } from "../../../node_modules/lucide-react/dist/esm/icons/brackets.js";
import { Parentheses } from "../../../node_modules/lucide-react/dist/esm/icons/parentheses.js";
import { ActionContextTypes } from "../../shortcuts/types.js";
import { wrapRangeWithPair } from "../../utils/codemirror.js";
//#region src/plugins/mobile-keyboard-toolbar/actions.ts
var INSERT_PAGE_REF_TRIGGER_ACTION_ID = "edit.cm.insert_page_ref_trigger";
var INSERT_BLOCK_REF_TRIGGER_ACTION_ID = "edit.cm.insert_block_ref_trigger";
var insertCompletionTrigger = (editorView, open, close) => {
	const { state } = editorView;
	editorView.dispatch(state.changeByRange((range) => wrapRangeWithPair(state, range, open, close)));
	editorView.focus();
	startCompletion(editorView);
};
var completionTriggerAction = (id, description, open, close, icon) => ({
	id,
	description,
	context: ActionContextTypes.EDIT_MODE_CM,
	icon,
	handler: async (deps) => {
		insertCompletionTrigger(deps.editorView, open, close);
	}
});
var mobileKeyboardToolbarActions = [completionTriggerAction(INSERT_PAGE_REF_TRIGGER_ACTION_ID, "Insert page reference", "[[", "]]", Brackets), completionTriggerAction(INSERT_BLOCK_REF_TRIGGER_ACTION_ID, "Insert block reference", "((", "))", Parentheses)];
//#endregion
export { INSERT_BLOCK_REF_TRIGGER_ACTION_ID, INSERT_PAGE_REF_TRIGGER_ACTION_ID, mobileKeyboardToolbarActions };

//# sourceMappingURL=actions.js.map