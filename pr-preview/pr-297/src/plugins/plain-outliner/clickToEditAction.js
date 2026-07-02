import { ActionContextTypes } from "../../shortcuts/types.js";
import { enterEditModeForBlock } from "../../extensions/blockInteraction.js";
import { grabSoftKeyboard } from "../../utils/softKeyboardGrab.js";
//#region src/plugins/plain-outliner/clickToEditAction.ts
var ENTER_BLOCK_EDIT_MODE_ACTION_ID = "block.enter-edit-mode";
/**
* Click-to-edit as a pointer-bound action: a plain (un-modified) click on a
* block's shell enters edit mode at the click position. The pointer binding's
* exact-modifier match means it only fires on a bare click — ctrl/meta/shift
* selection gestures match the selection actions instead and never reach here.
*
* Interactive descendants (links, buttons, …) are excluded by the
* `block-pointer` context's `pointerTargetFilter`, so this action never sees
* them and doesn't re-check — that "not my gesture" decision lives once, on the
* context, rather than in every block pointer action.
*
* Lives in the `block-pointer` context: never keyboard-active, dispatched only
* via the pointer path with the clicked block's deps supplied. Vim normal mode
* decorates it (via the action-dispatch seam) to focus-without-editing, the same
* way it used to win the `blockClickHandlersFacet` last-contribution race.
*/
var enterBlockEditModeOnClickAction = {
	id: ENTER_BLOCK_EDIT_MODE_ACTION_ID,
	description: "Enter edit mode on click",
	context: ActionContextTypes.BLOCK_POINTER,
	pointerBinding: {
		kind: "mouse",
		mods: [],
		phase: "click"
	},
	handler: ({ block, uiStateBlock, renderScopeId }, trigger) => {
		if (!uiStateBlock.repo.isReadOnly) grabSoftKeyboard();
		const event = trigger;
		enterEditModeForBlock(block, uiStateBlock, renderScopeId, {
			x: event.clientX,
			y: event.clientY
		});
	}
};
//#endregion
export { ENTER_BLOCK_EDIT_MODE_ACTION_ID, enterBlockEditModeOnClickAction };

//# sourceMappingURL=clickToEditAction.js.map