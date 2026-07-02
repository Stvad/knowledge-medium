import { systemToggle } from "../../facets/togglable.js";
import { diagnosticsFacet } from "../diagnostics/facet.js";
import { consistencyAuditEffectContribution } from "./schedule.js";
import { createDataIntegrityDiagnosticSource } from "./diagnosticsSource.js";
//#region src/plugins/data-integrity/index.ts
/** Owns the built-in consistency audit (L3): the engine + cadenced scheduling
*  (AppEffect) run here, and the result is surfaced via the diagnostics seam,
*  which the system-status chip aggregates. */
var dataIntegrityPlugin = ({ repo }) => systemToggle({
	id: "system:data-integrity",
	name: "Data integrity",
	description: "Runs the built-in consistency audit and surfaces its health in the system-status indicator."
}).of([consistencyAuditEffectContribution, diagnosticsFacet.of(createDataIntegrityDiagnosticSource(repo), { source: "data-integrity" })]);
//#endregion
export { dataIntegrityPlugin };

//# sourceMappingURL=index.js.map