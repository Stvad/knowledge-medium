import { systemToggle } from "../../facets/togglable.js";
import { actionsFacet, appMountsFacet, headerItemsFacet } from "../../extensions/core.js";
import { leftSidebarSectionsFacet } from "./facet.js";
import { LeftSidebar, LeftSidebarCoreSection, LeftSidebarShortcutsSection } from "./LeftSidebar.js";
import { LeftSidebarHeaderItem } from "./HeaderItem.js";
import { OPEN_LEFT_SIDEBAR_ACTION_ID, leftSidebarActions, openLeftSidebarAction } from "./actions.js";
//#region src/plugins/left-sidebar/index.ts
var leftSidebarMount = {
	id: "left-sidebar.mount",
	component: LeftSidebar
};
var leftSidebarHeaderItem = {
	id: "left-sidebar.header-trigger",
	region: "start",
	component: LeftSidebarHeaderItem
};
var leftSidebarCoreSection = {
	id: "left-sidebar.core",
	component: LeftSidebarCoreSection
};
var leftSidebarShortcutsSection = {
	id: "left-sidebar.shortcuts",
	component: LeftSidebarShortcutsSection
};
var leftSidebarPlugin = systemToggle({
	id: "system:left-sidebar",
	name: "Left sidebar",
	description: "Collapsible sidebar with section contributions from other plugins."
}).of([
	leftSidebarActions.map((action) => actionsFacet.of(action, { source: "left-sidebar" })),
	appMountsFacet.of(leftSidebarMount, { source: "left-sidebar" }),
	headerItemsFacet.of(leftSidebarHeaderItem, {
		source: "left-sidebar",
		precedence: -20
	}),
	leftSidebarSectionsFacet.of(leftSidebarCoreSection, {
		source: "left-sidebar",
		precedence: 0
	}),
	leftSidebarSectionsFacet.of(leftSidebarShortcutsSection, {
		source: "left-sidebar",
		precedence: 10
	})
]);
//#endregion
export { LeftSidebar, LeftSidebarHeaderItem, OPEN_LEFT_SIDEBAR_ACTION_ID, leftSidebarActions, leftSidebarCoreSection, leftSidebarHeaderItem, leftSidebarMount, leftSidebarPlugin, leftSidebarSectionsFacet, leftSidebarShortcutsSection, openLeftSidebarAction };

//# sourceMappingURL=index.js.map