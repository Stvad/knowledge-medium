import { actionsFacet } from "../../extensions/core.js";
import { showError, showProgress } from "../../utils/toast.js";
import { ShieldCheck } from "../../../node_modules/lucide-react/dist/esm/icons/shield-check.js";
import { ActionContextTypes } from "../../shortcuts/types.js";
import { getDialogQueue, openDialog } from "../../utils/dialogs.js";
import { RUN_DATA_INTEGRITY_AUDIT_ACTION_ID, VIEW_DATA_INTEGRITY_AUDIT_ACTION_ID } from "./store.js";
import { runConsistencyAuditNow } from "./schedule.js";
import { ConsistencyAuditDialog } from "./ConsistencyAuditDialog.js";
//#region src/plugins/data-integrity/auditAction.ts
/**
* On-demand data-integrity audit (L3) as GLOBAL actions:
*   - `run_data_integrity_audit` — RUN the audit, then show its results. In the
*     command palette ("Run data integrity audit"); the results dialog also
*     carries its own "Re-run" button.
*   - `view_data_integrity_audit` — RE-OPEN the results dialog for the LAST run
*     WITHOUT re-scanning (cheap). In the command palette ("View last data
*     integrity audit") and behind the status dropdown's generic "Inspect"
*     button — the diagnostics snapshot points that button here via `actionId`.
*
* Both open `ConsistencyAuditDialog`, which reads the last published result from
* the audit store — so viewing the last run costs nothing, and a fresh run just
* republishes into the same store.
*
* Lives in the data-integrity plugin (which owns the audit engine, store, and
* scheduling) rather than core or system-status: the action owns its results UI
* — a progress toast while it runs, then the ConsistencyAuditDialog — and keeps
* every data-integrity concern under one plugin/toggle. The system-status chip
* stays generic, surfacing this (and any) source only through the diagnostics
* seam's `actionId`.
*/
/** True when an open results dialog is ALREADY pinned to `workspaceId`. Both
*  actions pin the dialog at open (run → the scanned workspace, view → the active
*  one), so this is an EXACT prop match — the queue entry honestly records the
*  workspace it shows. It keeps the cheap, repeatable "View last" / "Inspect"
*  affordances from stacking a second copy for the SAME workspace, while still
*  letting a view of a DIFFERENT workspace through (a dialog pinned to ws-A must
*  not suppress an Inspect for ws-B). A deliberate "Run" is never gated on this —
*  it always surfaces its own result. */
var auditDialogAlreadyShows = (workspaceId) => getDialogQueue().some((entry) => entry.Component === ConsistencyAuditDialog && entry.props.workspaceId === (workspaceId ?? void 0));
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
			openDialog(ConsistencyAuditDialog, { workspaceId });
		} catch (e) {
			progress.fail(`Data integrity audit failed: ${e instanceof Error ? e.message : String(e)}`);
		}
	}
};
/** View the LAST audit without re-running it — opens the same results dialog,
*  which reads the last published result from the store (or an empty state with
*  a "Run audit" button if none has run this session). */
var viewDataIntegrityAuditAction = {
	id: VIEW_DATA_INTEGRITY_AUDIT_ACTION_ID,
	description: "View last data integrity audit",
	context: ActionContextTypes.GLOBAL,
	icon: ShieldCheck,
	handler: ({ uiStateBlock }) => {
		const workspaceId = uiStateBlock.repo.activeWorkspaceId;
		if (auditDialogAlreadyShows(workspaceId)) return;
		openDialog(ConsistencyAuditDialog, { workspaceId: workspaceId ?? void 0 });
	}
};
var runDataIntegrityAuditActionContribution = actionsFacet.of(runDataIntegrityAuditAction, { source: "data-integrity" });
var viewDataIntegrityAuditActionContribution = actionsFacet.of(viewDataIntegrityAuditAction, { source: "data-integrity" });
//#endregion
export { runDataIntegrityAuditAction, runDataIntegrityAuditActionContribution, viewDataIntegrityAuditAction, viewDataIntegrityAuditActionContribution };

//# sourceMappingURL=auditAction.js.map