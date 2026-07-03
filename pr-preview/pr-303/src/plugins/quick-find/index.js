import { propertySchemasFacet } from "../../data/facets.js";
import { systemToggle } from "../../facets/togglable.js";
import { actionsFacet, appMountsFacet, headerItemsFacet } from "../../extensions/core.js";
import { pluginUIStateExtension } from "../../data/pluginStateExtensions.js";
import { Search } from "../../../node_modules/lucide-react/dist/esm/icons/search.js";
import { ActionContextTypes } from "../../shortcuts/types.js";
import { quickFindToggle } from "./toggleStore.js";
import { QuickFindHeaderItem } from "./HeaderItem.js";
import { RECENT_BLOCKS_LIMIT, pushRecentBlockId, quickFindUIStateType, recentBlockIdsProp } from "./recents.js";
import { QuickFind } from "./QuickFind.js";
//#region src/plugins/quick-find/index.ts
var quickFindMount = {
	id: "quick-find.dialog",
	component: QuickFind
};
var QUICK_FIND_ACTION_ID = "quick_find";
var quickFindAction = {
	id: QUICK_FIND_ACTION_ID,
	description: "Find or create page or block",
	context: ActionContextTypes.GLOBAL,
	icon: Search,
	handler: () => {
		quickFindToggle.toggle();
	},
	defaultBinding: { keys: "$mod+p" }
};
var quickFindHeaderItem = {
	id: "quick-find.header",
	region: "start",
	component: QuickFindHeaderItem
};
var quickFindPlugin = systemToggle({
	id: "system:quick-find",
	name: "Quick find",
	description: "Cmd+P jump-to-block by alias, content, or relative date."
}).of([
	appMountsFacet.of(quickFindMount, { source: "quick-find" }),
	propertySchemasFacet.of(recentBlockIdsProp, { source: "quick-find" }),
	...pluginUIStateExtension(quickFindUIStateType, "quick-find"),
	actionsFacet.of(quickFindAction, { source: "quick-find" }),
	headerItemsFacet.of(quickFindHeaderItem, {
		source: "quick-find",
		precedence: 10
	})
]);
//#endregion
export { QUICK_FIND_ACTION_ID, QuickFind, QuickFindHeaderItem, RECENT_BLOCKS_LIMIT, pushRecentBlockId, quickFindAction, quickFindHeaderItem, quickFindMount, quickFindPlugin, recentBlockIdsProp };

//# sourceMappingURL=index.js.map