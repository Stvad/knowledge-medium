import { systemToggle } from "../../facets/togglable.js";
import { appMountsFacet } from "../../extensions/core.js";
import { mobileBottomNavItemsFacet } from "./facet.js";
import { MobileBottomNavButton } from "./Button.js";
import { MobileBottomNav } from "./MobileBottomNav.js";
import { appendTodayDailyBlockBottomNavItem, commandPaletteBottomNavItem, newNodeBottomNavItem, openSidebarBottomNavItem, searchBottomNavItem, todayBottomNavItem, undoBottomNavItem } from "./defaultItems.js";
//#region src/plugins/mobile-bottom-nav/index.ts
var mobileBottomNavMount = {
	id: "mobile-bottom-nav.mount",
	component: MobileBottomNav
};
var mobileBottomNavPlugin = systemToggle({
	id: "system:mobile-bottom-nav",
	name: "Mobile bottom nav",
	description: "Bottom navigation bar shown on mobile viewports."
}).of([
	appMountsFacet.of(mobileBottomNavMount, { source: "mobile-bottom-nav" }),
	mobileBottomNavItemsFacet.of(openSidebarBottomNavItem, {
		source: "mobile-bottom-nav",
		precedence: -40
	}),
	mobileBottomNavItemsFacet.of(newNodeBottomNavItem, {
		source: "mobile-bottom-nav",
		precedence: -30
	}),
	mobileBottomNavItemsFacet.of(appendTodayDailyBlockBottomNavItem, {
		source: "mobile-bottom-nav",
		precedence: -25
	}),
	mobileBottomNavItemsFacet.of(todayBottomNavItem, {
		source: "mobile-bottom-nav",
		precedence: -35
	}),
	mobileBottomNavItemsFacet.of(searchBottomNavItem, {
		source: "mobile-bottom-nav",
		precedence: -10
	}),
	mobileBottomNavItemsFacet.of(undoBottomNavItem, {
		source: "mobile-bottom-nav",
		precedence: -5
	}),
	mobileBottomNavItemsFacet.of(commandPaletteBottomNavItem, {
		source: "mobile-bottom-nav",
		precedence: 0
	})
]);
//#endregion
export { MobileBottomNav, MobileBottomNavButton, appendTodayDailyBlockBottomNavItem, commandPaletteBottomNavItem, mobileBottomNavItemsFacet, mobileBottomNavMount, mobileBottomNavPlugin, newNodeBottomNavItem, openSidebarBottomNavItem, searchBottomNavItem, todayBottomNavItem, undoBottomNavItem };

//# sourceMappingURL=index.js.map