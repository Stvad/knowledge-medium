import { CallbackSet } from "../../utils/callbackSet.js";
import { getPersistenceState, subscribePersistenceChange } from "../../requestPersistentStorage.js";
//#region src/plugins/storage-persistence/persistenceStatus.ts
/**
* A diagnostics source that surfaces "this origin's local storage isn't
* persistent" as an ambient nudge on the status chip — the quiet, contextual
* reminder (vs. nagging the raw browser prompt every load; see
* src/requestPersistentStorage.ts).
*
* It's a small live store: it re-reads the persistence state and republishes a
* `DiagnosticSnapshot` (ref-stable while unchanged). Persistence can flip to
* granted later — the browser auto-grants on PWA install / enough engagement —
* so it re-checks when the tab regains focus and clears the nudge on its own.
*/
var REQUEST_PERSISTENCE_ACTION_ID = "storage.requestPersistence";
var snapshot = null;
var started = false;
var refreshSeq = 0;
var listeners = new CallbackSet("persistence-status");
var notify = () => listeners.notify();
var sameSnapshot = (a, b) => {
	if (a === b) return true;
	if (!a || !b) return false;
	return a.severity === b.severity && a.summary === b.summary && a.detail === b.detail && a.actionId === b.actionId && a.actionLabel === b.actionLabel && a.nudge === b.nudge;
};
var computeSnapshot = (state) => {
	if (state.persisted || !state.supported) return null;
	if (state.permission === "denied") return {
		severity: "warning",
		summary: "Storage access is blocked",
		detail: "Re-enable storage for this site in your browser's settings to keep local data from being evicted.",
		nudge: true
	};
	return {
		severity: "warning",
		summary: "Local data isn't protected on this device",
		detail: "It could be evicted if the device runs low on storage. Protect it to keep your offline data and unsynced edits safe.",
		actionId: REQUEST_PERSISTENCE_ACTION_ID,
		actionLabel: "Protect",
		nudge: true
	};
};
/** Re-read the live persistence state and republish the snapshot when it changes. */
var refreshPersistenceStatus = async () => {
	const seq = ++refreshSeq;
	const next = computeSnapshot(await getPersistenceState());
	if (seq !== refreshSeq) return;
	if (sameSnapshot(snapshot, next)) return;
	snapshot = next;
	notify();
};
var onVisibilityChange = () => {
	if (document.visibilityState === "visible") refreshPersistenceStatus();
};
var unsubscribeChange = null;
var start = () => {
	if (started) return;
	started = true;
	if (typeof document !== "undefined") document.addEventListener("visibilitychange", onVisibilityChange);
	unsubscribeChange = subscribePersistenceChange(() => void refreshPersistenceStatus());
	refreshPersistenceStatus();
};
var stop = () => {
	if (!started) return;
	started = false;
	if (typeof document !== "undefined") document.removeEventListener("visibilitychange", onVisibilityChange);
	unsubscribeChange?.();
	unsubscribeChange = null;
};
/** Test-only reset of the module store (mirrors data-integrity's
*  resetConsistencyAuditStore). Detaches listeners and clears state. */
var resetPersistenceStatus = () => {
	stop();
	listeners.clear();
	snapshot = null;
	refreshSeq = 0;
};
var persistenceDiagnosticSource = {
	id: "storage-persistence",
	label: "Storage",
	subscribe: (listener) => {
		const off = listeners.add(listener);
		start();
		return () => {
			off();
			if (listeners.size === 0) stop();
		};
	},
	getSnapshot: () => snapshot
};
//#endregion
export { REQUEST_PERSISTENCE_ACTION_ID, persistenceDiagnosticSource, refreshPersistenceStatus, resetPersistenceStatus };

//# sourceMappingURL=persistenceStatus.js.map