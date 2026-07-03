import { isLocalDbCorruptionError, isRuntimeDbCorruptionError } from "./localDbCorruption.js";
import { dbForensics } from "./dbForensics.js";
import { reportRuntimeLocalDbCorruption } from "../data/localDbCorruptionSignal.js";
//#region src/utils/dbForensicsHooks.ts
/**
* Wiring between the app boot/lifecycle and the out-of-band {@link dbForensics}
* recorder. Kept separate from `dbForensics` (pure store) and from
* `repoProvider` (which just calls these) so the glue — the per-user watcher,
* the lifecycle listeners, the retrieval hook — lives in one place.
*/
var downloadErrorOf = (s) => s?.dataFlowStatus?.downloadError ?? s?.downloadError;
var messageOf = (error) => error instanceof Error ? error.message : String(error);
var sessionRecorded = false;
var lifecycleInstalled = false;
var watchedUserId = null;
var disposeWatch = null;
var runtimeCorruptionCaptured = false;
/**
* Record a new forensic session (unclean-shutdown detection). Once per page
* load — the session is the page-load lifetime, so later `ensurePowerSyncReady`
* calls (re-render / in-page account switch) are no-ops. Best-effort; never throws.
*/
var recordForensicSessionStart = (userId, dbFilename, forensics = dbForensics) => {
	if (sessionRecorded) return;
	sessionRecorded = true;
	forensics.recordSessionStart({
		userId,
		dbFilename
	});
};
/** Capture a forensic snapshot on a DB-OPEN corruption, before recovery. */
var captureDbOpenCorruption = (userId, dbFilename, error, forensics = dbForensics) => {
	if (!isLocalDbCorruptionError(error)) return;
	forensics.captureCorruptionSnapshot({
		userId,
		dbFilename,
		reason: "db-open-corrupt",
		sql: { message: messageOf(error) }
	});
};
/**
* Watch the PowerSync connection for a RUNTIME sync-apply corruption
* (`downloadError`) — the class the DB-open detector never sees (connect isn't
* awaited). On the first corruption it captures a forensic snapshot AND routes
* to the recovery UI via `reportRuntimeLocalDbCorruption` → the sentinel → the
* bootstrap ErrorBoundary. Both gate on the strict, reset-gating matcher so a
* benign sync failure neither consumes the one-shot capture nor shows the UI.
*
* Re-arms per user: on an in-page account switch it disposes the previous
* listener and rebinds to the new user's db.
*/
var watchForRuntimeCorruption = (db, userId, dbFilename, forensics = dbForensics) => {
	if (watchedUserId === userId) return;
	disposeWatch?.();
	disposeWatch = null;
	watchedUserId = userId;
	runtimeCorruptionCaptured = false;
	const check = (status) => {
		const err = downloadErrorOf(status);
		if (err === void 0 || err === null || !isRuntimeDbCorruptionError(err)) return;
		if (!runtimeCorruptionCaptured) {
			runtimeCorruptionCaptured = true;
			forensics.captureCorruptionSnapshot({
				userId,
				dbFilename,
				reason: "runtime-sync-corrupt",
				sql: { downloadError: messageOf(err) }
			});
		}
		reportRuntimeLocalDbCorruption(userId, err);
	};
	check(db.currentStatus);
	disposeWatch = typeof db.registerListener === "function" ? db.registerListener({ statusChanged: check }) : null;
};
/** Test-only: reset the once-per-process guards + per-user watcher state. */
var __resetDbForensicsHooksForTest = () => {
	sessionRecorded = false;
	lifecycleInstalled = false;
	disposeWatch?.();
	disposeWatch = null;
	watchedUserId = null;
	runtimeCorruptionCaptured = false;
};
/**
* Register global lifecycle listeners that feed the current session's breadcrumb
* log + clean-shutdown flag, and expose a retrieval hook on
* `window.__omniliner.forensics` (`dump()` / `download()`) so the recorded
* breadcrumbs + corruption snapshots can be pulled over the remote inspector or
* downloaded next incident. `pagehide` marks a clean exit; `pageshow`/`resume`
* un-mark it (the session is live again — avoids a bfcache false-negative).
* Idempotent; call once at app startup.
*/
var installDbForensicsLifecycle = (forensics = dbForensics) => {
	if (lifecycleInstalled || typeof window === "undefined") return;
	lifecycleInstalled = true;
	document.addEventListener("visibilitychange", () => {
		forensics.recordLifecycleEvent(`visibility:${document.visibilityState}`);
	});
	window.addEventListener("freeze", () => void forensics.recordLifecycleEvent("freeze"));
	window.addEventListener("pagehide", () => void forensics.markCleanShutdown());
	window.addEventListener("pageshow", () => void forensics.clearCleanShutdown());
	window.addEventListener("resume", () => void forensics.clearCleanShutdown());
	const ns = window.__omniliner ?? {};
	ns.forensics = {
		dump: () => forensics.exportAll(),
		download: async () => downloadJson("db-forensics.json", await forensics.exportAll())
	};
	window.__omniliner = ns;
};
var downloadJson = (filename, data) => {
	const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
	const url = URL.createObjectURL(blob);
	try {
		const a = document.createElement("a");
		a.href = url;
		a.download = filename;
		document.body.appendChild(a);
		a.click();
		a.remove();
	} finally {
		setTimeout(() => URL.revokeObjectURL(url), 0);
	}
};
//#endregion
export { __resetDbForensicsHooksForTest, captureDbOpenCorruption, installDbForensicsLifecycle, recordForensicSessionStart, watchForRuntimeCorruption };

//# sourceMappingURL=dbForensicsHooks.js.map