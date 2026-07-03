import { VIEW_DATA_INTEGRITY_AUDIT_ACTION_ID, getConsistencyAuditSnapshotFor, subscribeConsistencyAudit } from "./store.js";
//#region src/plugins/data-integrity/diagnosticsSource.ts
var anomalousChecks = (result) => Object.entries(result.checks).filter(([, c]) => c.status === "anomaly").map(([name]) => name);
var erroredChecks = (result) => Object.entries(result.checks).filter(([, c]) => c.status === "error").map(([name]) => name);
/** Checks that are 'ok' but still carry a benign sub-threshold signal (e.g.
*  `property_ref_at_rest` reporting a `total` below the alert floor). Surfaced as
*  muted info so the baseline stays visible in the chip without alarming —
*  preserving the pre-seam "below alert threshold" band. */
var subThresholdChecks = (result) => Object.entries(result.checks).filter(([, c]) => c.status === "ok" && Number(c.total) > 0).map(([name, c]) => ({
	name,
	total: Number(c.total)
}));
/** Pure mapping from an audit result to a diagnostic snapshot. Anomalies → error
*  (reddens the chip); a check that couldn't run → warning; a sub-threshold
*  baseline → info; otherwise ok. All non-error severities stay in the dropdown
*  without alarming the dot (matching the pre-seam behavior). */
var mapAuditToSnapshot = (result) => {
	const anomalies = result.anomalies;
	const errored = erroredChecks(result);
	const subThreshold = subThresholdChecks(result);
	const severity = anomalies > 0 ? "error" : errored.length > 0 ? "warning" : subThreshold.length > 0 ? "info" : "ok";
	const summary = anomalies > 0 ? `${anomalies} ${anomalies === 1 ? "issue" : "issues"} found` : errored.length > 0 ? `${errored.length} ${errored.length === 1 ? "check" : "checks"} couldn't run` : subThreshold.length > 0 ? `${subThreshold.length} below-threshold ${subThreshold.length === 1 ? "finding" : "findings"}` : "All checks passed";
	const detailParts = [];
	const flagged = anomalousChecks(result);
	if (flagged.length) detailParts.push(flagged.join(", "));
	if (errored.length) detailParts.push(`couldn't run: ${errored.join(", ")}`);
	if (anomalies === 0 && errored.length === 0 && subThreshold.length) detailParts.push(subThreshold.map((s) => `${s.name}: ${s.total}`).join(", "));
	return {
		severity,
		summary,
		detail: detailParts.join(" · ") || void 0,
		actionId: VIEW_DATA_INTEGRITY_AUDIT_ACTION_ID
	};
};
/** Build the diagnostic source. The audit store keeps results per workspace, so
*  read the ACTIVE workspace's result via `getConsistencyAuditSnapshotFor`: a
*  result for another workspace reports nothing (rather than the wrong counts)
*  until this workspace's audit publishes. Memoized so getSnapshot is ref-stable. */
var createDataIntegrityDiagnosticSource = (repo) => {
	let cachedKey = "";
	let cachedSnapshot = null;
	return {
		id: "data-integrity",
		label: "Data integrity",
		subscribe: subscribeConsistencyAudit,
		getSnapshot: () => {
			const active = repo.activeWorkspaceId;
			const result = getConsistencyAuditSnapshotFor(active);
			if (!result) {
				const key = `none:${active ?? ""}`;
				if (key !== cachedKey) {
					cachedKey = key;
					cachedSnapshot = null;
				}
				return cachedSnapshot;
			}
			const key = `${result.workspaceId}:${result.checkedAt}:${result.anomalies}`;
			if (key !== cachedKey) {
				cachedKey = key;
				cachedSnapshot = mapAuditToSnapshot(result);
			}
			return cachedSnapshot;
		}
	};
};
//#endregion
export { createDataIntegrityDiagnosticSource, mapAuditToSnapshot };

//# sourceMappingURL=diagnosticsSource.js.map