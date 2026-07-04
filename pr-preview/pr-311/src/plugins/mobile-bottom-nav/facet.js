import { dedupById, defineFacet } from "../../facets/facet.js";
import { isActionRefContribution } from "../../shortcuts/actionRefItems.js";
//#region src/plugins/mobile-bottom-nav/facet.ts
var mobileBottomNavItemsFacet = defineFacet({
	id: "mobile-bottom-nav.items",
	combine: dedupById("mobile-bottom-nav.items"),
	validate: isActionRefContribution
});
//#endregion
export { mobileBottomNavItemsFacet };

//# sourceMappingURL=facet.js.map