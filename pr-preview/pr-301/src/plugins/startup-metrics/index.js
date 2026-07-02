import { propertySchemasFacet, typesFacet } from "../../data/facets.js";
import { systemToggle } from "../../facets/togglable.js";
import { appEffectsFacet } from "../../extensions/core.js";
import { collectStartupMetricsEffect, startupMetricsUIStateType, startupRecordProp } from "./record.js";
//#region src/plugins/startup-metrics/index.ts
/** Records a durable per-session cold-start timeline (TTI + settled + the phase
*  breakdown) as a block-per-session under a hidden ui-state subtree, so
*  loading-time trends are observable over builds instead of ephemeral. */
var startupMetricsPlugin = systemToggle({
	id: "system:startup-metrics",
	name: "Startup metrics",
	description: "Records time-to-interactivity and settle timings each load so regressions are visible over time."
}).of([
	appEffectsFacet.of(collectStartupMetricsEffect, { source: "startup-metrics" }),
	propertySchemasFacet.of(startupRecordProp, { source: "startup-metrics" }),
	typesFacet.of(startupMetricsUIStateType, { source: "startup-metrics" })
]);
//#endregion
export { startupMetricsPlugin };

//# sourceMappingURL=index.js.map