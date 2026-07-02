import { actionsFacet } from "../../extensions/core.js";
import { showError, showProgress } from "../../utils/toast.js";
import { ShieldCheck } from "../../../node_modules/lucide-react/dist/esm/icons/shield-check.js";
import { ActionContextTypes } from "../../shortcuts/types.js";
import { openDialog } from "../../utils/dialogs.js";
import { RUN_DATA_INTEGRITY_AUDIT_ACTION_ID } from "../data-integrity/store.js";
import { runConsistencyAuditNow } from "../data-integrity/schedule.js";
import { ConsistencyAuditDialog } from "./ConsistencyAuditDialog.js";
//#region src/plugins/system-status/auditAction.ts
/**
* On-demand data-integrity audit (L3) as a GLOBAL action — shows in the command
* palette ("Run data integrity audit") and is triggered by the "Re-run audit"
* button in the status dropdown (via `runActionById`).
*
* Lives in the system-status plugin (not core defaultShortcuts) so the action can
* own its results UI — a progress toast while it runs, then the
* ConsistencyAuditDialog — without core depending on a plugin component.
*/
var runDataIntegrityAuditAction = {
	id: RUN_DATA_INTEGRITY_AUDIT_ACTION_ID,
	description: "Run data integrity audit",
	context: ActionContextTypes.GLOBAL,
	icon: ShieldCheck,
	handler: async ({ uiStateBlock }) => {
		const { repo } = uiStateBlock;
		const workspaceId = repo.activeWorkspaceId;
		if (!workspaceId) {
			showError("Data integrity audit: no active workspace.");
			return;
		}
		const progress = showProgress("Running data integrity audit…");
		try {
			const result = await runConsistencyAuditNow(repo, workspaceId);
			if (result.anomalies > 0) progress.fail(`Data integrity: ${result.anomalies} ${result.anomalies === 1 ? "issue" : "issues"} found — see details.`);
			else progress.done("Data integrity audit: no issues found.");
			openDialog(ConsistencyAuditDialog, { result });
		} catch (e) {
			progress.fail(`Data integrity audit failed: ${e instanceof Error ? e.message : String(e)}`);
		}
	}
};
var runDataIntegrityAuditActionContribution = actionsFacet.of(runDataIntegrityAuditAction, { source: "system-status" });
//#endregion
export { runDataIntegrityAuditAction, runDataIntegrityAuditActionContribution };

//# sourceMappingURL=auditAction.js.map