import { systemToggle } from "../../facets/togglable.js";
import { headerItemsFacet } from "../../extensions/core.js";
import { SystemStatusHeaderItem } from "./SystemStatusHeaderItem.js";
import { runDataIntegrityAuditActionContribution } from "./auditAction.js";
//#region src/plugins/system-status/index.ts
var systemStatusHeaderItem = {
	id: "system-status.header",
	region: "end",
	component: SystemStatusHeaderItem
};
var systemStatusPlugin = systemToggle({
	id: "system:sync-status",
	name: "System status",
	description: "Header status indicator — sync state plus health signals (data integrity, storage, app updates)."
}).of([headerItemsFacet.of(systemStatusHeaderItem, {
	source: "system-status",
	precedence: 40
}), runDataIntegrityAuditActionContribution]);
//#endregion
export { systemStatusHeaderItem, systemStatusPlugin };

//# sourceMappingURL=index.js.map