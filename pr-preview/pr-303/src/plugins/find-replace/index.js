import { systemToggle } from "../../facets/togglable.js";
import { actionsFacet, appMountsFacet, headerItemsFacet } from "../../extensions/core.js";
import { FIND_REPLACE_APPLY_CONTENT_REPLACE_MUTATOR, FIND_REPLACE_SEARCH_CONTENT_QUERY, findReplaceDataExtension } from "./dataExtension.js";
import { Search } from "../../../node_modules/lucide-react/dist/esm/icons/search.js";
import { ActionContextTypes } from "../../shortcuts/types.js";
import { findReplaceToggle } from "./toggleStore.js";
import { FindReplaceDialog } from "./FindReplaceDialog.js";
import { FindReplaceHeaderItem } from "./HeaderItem.js";
//#region src/plugins/find-replace/index.ts
var findReplaceMount = {
	id: "find-replace.dialog",
	component: FindReplaceDialog
};
var FIND_REPLACE_ACTION_ID = "find_replace.open";
var findReplaceAction = {
	id: FIND_REPLACE_ACTION_ID,
	description: "Find and replace",
	context: ActionContextTypes.GLOBAL,
	icon: Search,
	handler: () => {
		findReplaceToggle.toggle();
	},
	defaultBinding: { keys: "$mod+Shift+f" }
};
var findReplaceHeaderItem = {
	id: "find-replace.header",
	region: "start",
	component: FindReplaceHeaderItem
};
/** Nested toggle for the search icon in the header. Sits inside the
*  outer `system:find-replace` boundary, so disabling find-replace
*  drops everything including this item. Disabling just this inner
*  toggle removes the icon from the header while keeping the
*  Cmd+Shift+F action and the dialog wired — users who navigate via
*  the keyboard or command palette can still open find-replace, just
*  without the header affordance. */
var findReplaceHeaderToggle = systemToggle({
	id: "system:find-replace/header-item",
	name: "Search icon in header",
	description: "Disable to hide find-replace from the global header (Cmd+Shift+F still works).",
	defaultEnabled: false
});
var findReplacePlugin = systemToggle({
	id: "system:find-replace",
	name: "Find and replace",
	description: "Cmd+Shift+F search-and-replace across the workspace."
}).of([
	findReplaceDataExtension,
	appMountsFacet.of(findReplaceMount, { source: "find-replace" }),
	actionsFacet.of(findReplaceAction, { source: "find-replace" }),
	findReplaceHeaderToggle.of(headerItemsFacet.of(findReplaceHeaderItem, {
		source: "find-replace",
		precedence: 15
	}))
]);
//#endregion
export { FIND_REPLACE_ACTION_ID, FIND_REPLACE_APPLY_CONTENT_REPLACE_MUTATOR, FIND_REPLACE_SEARCH_CONTENT_QUERY, FindReplaceDialog, FindReplaceHeaderItem, findReplaceAction, findReplaceDataExtension, findReplaceHeaderItem, findReplaceMount, findReplacePlugin };

//# sourceMappingURL=index.js.map