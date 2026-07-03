import { dedupById, defineFacet } from "../../facets/facet.js";
import { isActionRefContribution } from "../../shortcuts/actionRefItems.js";
//#region src/plugins/mobile-keyboard-toolbar/facet.ts
/** The action id of the toolbar's "Done" button — the one entry that genuinely
*  wants edit mode to end, so the toolbar skips the edit-mode-keepalive hold for
*  it (see MobileKeyboardToolbar). */
var EXIT_EDIT_ACTION_ID = "exit_edit_mode_cm";
var mobileKeyboardToolbarItemsFacet = defineFacet({
	id: "mobile-keyboard-toolbar.items",
	combine: dedupById("mobile-keyboard-toolbar.items"),
	validate: isActionRefContribution
});
//#endregion
export { EXIT_EDIT_ACTION_ID, mobileKeyboardToolbarItemsFacet };

//# sourceMappingURL=facet.js.map