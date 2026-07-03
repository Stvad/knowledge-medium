import { systemToggle } from "../../facets/togglable.js";
import { headerItemsFacet } from "../../extensions/core.js";
import { AccountHeaderItem } from "./AccountHeaderItem.js";
//#region src/plugins/account-header/index.ts
var accountHeaderItem = {
	id: "account-header.user-menu",
	region: "end",
	component: AccountHeaderItem
};
var accountHeaderPlugin = systemToggle({
	id: "system:account-header",
	name: "Account header",
	description: "User identity badge and logout entry in the header."
}).of([headerItemsFacet.of(accountHeaderItem, {
	source: "account-header",
	precedence: 50
})]);
//#endregion
export { AccountHeaderItem, accountHeaderItem, accountHeaderPlugin };

//# sourceMappingURL=index.js.map