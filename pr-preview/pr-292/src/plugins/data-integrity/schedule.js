import { LAZY_DEEP_IDLE, scheduleDeepIdle } from "../../utils/scheduleIdle.js";
import { PendingIdleJobs } from "../../data/internals/idleMarkerJobs.js";
import { appEffectsFacet } from "../../extensions/core.js";
import { publishConsistencyAudit } from "./store.js";
import { runConsistencyAudit } from "./audit.js";
//#region src/plugins/data-integrity/schedule.ts
/**
* Cadenced scheduling for the built-in consistency audit (L3), as a plugin
* AppEffect — replacing the old Repo.scheduleConsistencyAudit idle job. The
* engine + scheduling live here (not core) so the engine can import other
* plugins' code (the deep checks in a later step) without inverting the layering.
*/
var CADENCE_MS = 1800 * 1e3;
var DIVERGENCE_RECHECK_MS = 4e3;
var lastRun = /* @__PURE__ */ new Map();
var jobs = new PendingIdleJobs((fn) => scheduleDeepIdle(fn, LAZY_DEEP_IDLE));
/** True if the workspace is due for a cadenced audit (never run this session, or
*  older than the cadence window). Exposed for tests. */
var isAuditDue = (workspaceId, now) => {
	const last = lastRun.get(workspaceId);
	return last === void 0 || now - last >= CADENCE_MS;
};
/** Run the audit now (bypassing the cadence gate), publish the result, and stamp
*  the cadence. Used by both the on-demand action and the cadenced effect. Passes
*  the §6 mode/key resolver so the divergence check can decrypt-compare e2ee
*  rows. Throws on failure so callers can surface it. */
var runConsistencyAuditNow = async (repo, workspaceId) => {
	const result = await runConsistencyAudit(repo.db, workspaceId, Date.now(), {
		divergenceRecheckMs: DIVERGENCE_RECHECK_MS,
		sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
		decrypt: repo.syncObserverDeps
	});
	lastRun.set(workspaceId, Date.now());
	publishConsistencyAudit(result);
	return result;
};
/** Long-lived effect: on each workspace open, schedule one cadenced audit on
*  idle. The effect lifecycle restarts on workspaceId change, so `start` is the
*  "workspace opened" hook. */
var consistencyAuditEffect = {
	id: "data-integrity.consistency-audit",
	start: ({ repo, workspaceId }) => {
		if (!workspaceId || !isAuditDue(workspaceId, Date.now())) return;
		let cancelled = false;
		jobs.schedule(async () => {
			if (cancelled || !isAuditDue(workspaceId, Date.now())) return;
			try {
				await runConsistencyAuditNow(repo, workspaceId);
			} catch (err) {
				console.error(`[data-integrity] audit for workspace ${workspaceId} failed`, err);
			}
		});
		return () => {
			cancelled = true;
		};
	}
};
var consistencyAuditEffectContribution = appEffectsFacet.of(consistencyAuditEffect, { source: "data-integrity" });
/** Test helper — drain in-flight cadenced audits. */
var drainConsistencyAudits = () => jobs.drain();
/** Test helper — clear the per-session cadence map. */
var resetConsistencyAuditCadence = () => lastRun.clear();
//#endregion
export { consistencyAuditEffect, consistencyAuditEffectContribution, drainConsistencyAudits, isAuditDue, resetConsistencyAuditCadence, runConsistencyAuditNow };

//# sourceMappingURL=schedule.js.map