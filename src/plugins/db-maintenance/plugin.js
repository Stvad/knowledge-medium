import { systemToggle } from "../../facets/togglable.js";
import { actionsFacet } from "../../extensions/core.js";
import { rebuildQueryStatsAction } from "./action.js";
//#region src/plugins/db-maintenance/plugin.ts
var dbMaintenancePlugin = ({ repo }) => systemToggle({
	id: "system:db-maintenance",
	name: "Database maintenance",
	description: "Adds a command to rebuild SQLite query statistics (ANALYZE) on demand."
}).of([actionsFacet.of(rebuildQueryStatsAction({ repo }), { source: "db-maintenance" })]);
//#endregion
export { dbMaintenancePlugin };

//# sourceMappingURL=plugin.js.map