import { CallbackSet } from "../../utils/callbackSet.js";
//#region src/plugins/data-integrity/store.ts
/** Id of the global action that runs the built-in audit on demand (registered by
*  the system-status plugin in auditAction.ts, triggered from the command palette
*  and the status dropdown via `runActionById`). Lives here so neither
*  caller has to import the other's module graph. */
var RUN_DATA_INTEGRITY_AUDIT_ACTION_ID = "run_data_integrity_audit";
var latest = null;
var listeners = new CallbackSet("data-integrity-audit");
/** Publish a completed audit result and notify subscribers. */
var publishConsistencyAudit = (result) => {
	latest = result;
	listeners.notify();
};
/** Current snapshot — a stable reference until the next publish (so it's safe
*  for useSyncExternalStore). */
var getConsistencyAuditSnapshot = () => latest;
var subscribeConsistencyAudit = (listener) => listeners.add(listener);
/** Test helper — clear the published result + listeners. */
var resetConsistencyAuditStore = () => {
	latest = null;
	listeners.clear();
};
//#endregion
export { RUN_DATA_INTEGRITY_AUDIT_ACTION_ID, getConsistencyAuditSnapshot, publishConsistencyAudit, resetConsistencyAuditStore, subscribeConsistencyAudit };

//# sourceMappingURL=store.js.map