import { systemToggle } from "../../facets/togglable.js";
import { diagnosticsFacet } from "../diagnostics/facet.js";
import { dialogAppMountExtension } from "../../extensions/dialogAppMount.js";
import { createDataIntegrityDiagnosticSource } from "./diagnosticsSource.js";
import { consistencyAuditEffectContribution } from "./schedule.js";
import { runDataIntegrityAuditActionContribution, viewDataIntegrityAuditActionContribution } from "./auditAction.js";
//#region src/plugins/data-integrity/index.ts
/** Owns the built-in consistency audit (L3) end to end: the engine + cadenced
*  scheduling (AppEffect), the on-demand run/view actions and their results
*  dialog, and the diagnostics-seam contribution the system-status chip
*  aggregates generically. Keeping the actions + dialog here (not in
*  system-status) means the chip has no data-integrity-specific knowledge — it
*  only knows the generic seam. */
var dataIntegrityPlugin = ({ repo }) => systemToggle({
	id: "system:data-integrity",
	name: "Data integrity",
	description: "Runs the built-in consistency audit and surfaces its health in the system-status indicator."
}).of([
	consistencyAuditEffectContribution,
	diagnosticsFacet.of(createDataIntegrityDiagnosticSource(repo), { source: "data-integrity" }),
	runDataIntegrityAuditActionContribution,
	viewDataIntegrityAuditActionContribution,
	dialogAppMountExtension
]);
//#endregion
export { dataIntegrityPlugin };

//# sourceMappingURL=index.js.map