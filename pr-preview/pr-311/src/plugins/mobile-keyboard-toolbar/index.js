import { systemToggle } from "../../facets/togglable.js";
import { actionsFacet, appMountsFacet } from "../../extensions/core.js";
import { mobileKeyboardToolbarActions } from "./actions.js";
import { EXIT_EDIT_ACTION_ID, mobileKeyboardToolbarItemsFacet } from "./facet.js";
import { defaultToolbarItems } from "./defaultItems.js";
import { MobileKeyboardToolbar } from "./MobileKeyboardToolbar.js";
//#region src/plugins/mobile-keyboard-toolbar/index.ts
var mobileKeyboardToolbarMount = {
	id: "mobile-keyboard-toolbar.mount",
	component: MobileKeyboardToolbar
};
var mobileKeyboardToolbarPlugin = systemToggle({
	id: "system:mobile-keyboard-toolbar",
	name: "Mobile keyboard toolbar",
	description: "Editing toolbar that floats above the on-screen keyboard on mobile."
}).of([
	mobileKeyboardToolbarActions.map((action) => actionsFacet.of(action, { source: "mobile-keyboard-toolbar" })),
	defaultToolbarItems.map(({ item, precedence }) => mobileKeyboardToolbarItemsFacet.of(item, {
		source: "mobile-keyboard-toolbar",
		precedence
	})),
	appMountsFacet.of(mobileKeyboardToolbarMount, { source: "mobile-keyboard-toolbar" })
]);
//#endregion
export { EXIT_EDIT_ACTION_ID, MobileKeyboardToolbar, mobileKeyboardToolbarActions, mobileKeyboardToolbarItemsFacet, mobileKeyboardToolbarMount, mobileKeyboardToolbarPlugin };

//# sourceMappingURL=index.js.map