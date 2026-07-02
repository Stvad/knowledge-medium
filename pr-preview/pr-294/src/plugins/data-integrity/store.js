import { CallbackSet } from "../../utils/callbackSet.js";
//#region src/plugins/data-integrity/store.ts
/** Id of the global action that runs the built-in audit on demand (registered by
*  this plugin in auditAction.ts, triggered from the command palette). Lives here
*  as a plain constant so a caller can reference the id without importing the
*  action's (React/dialog) module graph. */
var RUN_DATA_INTEGRITY_AUDIT_ACTION_ID = "run_data_integrity_audit";
/** Id of the global action that RE-OPENS the results dialog for the last audit
*  WITHOUT re-running it — reading the snapshot below. Registered alongside the
*  run action by this plugin; the diagnostics snapshot routes the status
*  dropdown's generic "Inspect" button here so viewing last results is cheap (no
*  expensive re-scan). */
var VIEW_DATA_INTEGRITY_AUDIT_ACTION_ID = "view_data_integrity_audit";
var latest = null;
var byWorkspace = /* @__PURE__ */ new Map();
var listeners = new CallbackSet("data-integrity-audit");
/** Publish a completed audit result and notify subscribers. */
var publishConsistencyAudit = (result) => {
	latest = result;
	byWorkspace.set(result.workspaceId, result);
	listeners.notify();
};
/** Most-recently-published result, ANY workspace — the "current health" pointer
*  the scheduling/diagnostics plumbing has always exposed. A stable reference
*  until the next publish. Prefer `getConsistencyAuditSnapshotFor` when you care
*  about a specific workspace (almost always). */
var getConsistencyAuditSnapshot = () => latest;
/** The last result FOR `workspaceId` — a stable reference until THAT workspace is
*  re-audited, or null. This is the single place the "the store is per-workspace,
*  scope it before use" invariant lives: a publish for another workspace does not
*  change what this returns, so a subscriber keyed on it (a dialog, the
*  diagnostics source) is never blanked by an unrelated audit. */
var getConsistencyAuditSnapshotFor = (workspaceId) => (workspaceId != null ? byWorkspace.get(workspaceId) : void 0) ?? null;
var subscribeConsistencyAudit = (listener) => listeners.add(listener);
/** Test helper — clear the published results + listeners. */
var resetConsistencyAuditStore = () => {
	latest = null;
	byWorkspace.clear();
	listeners.clear();
};
//#endregion
export { RUN_DATA_INTEGRITY_AUDIT_ACTION_ID, VIEW_DATA_INTEGRITY_AUDIT_ACTION_ID, getConsistencyAuditSnapshot, getConsistencyAuditSnapshotFor, publishConsistencyAudit, resetConsistencyAuditStore, subscribeConsistencyAudit };

//# sourceMappingURL=store.js.map