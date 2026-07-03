//#region src/data/metricsConsoleHook.ts
var installed = false;
var round = (n, decimals = 3) => Math.round(n * 10 ** decimals) / 10 ** decimals;
var counterRows = (snap) => {
	const rows = [];
	for (const [k, v] of Object.entries(snap.handleStore)) rows.push({
		section: "handleStore",
		field: k,
		value: v
	});
	for (const [k, v] of Object.entries(snap.blockCache)) rows.push({
		section: "blockCache",
		field: k,
		value: v
	});
	return rows;
};
var timingRows = (snap, labelKey) => {
	return Object.entries(snap).map(([name, t]) => ({
		[labelKey]: name,
		calls: t.calls,
		meanMs: round(t.meanMs),
		p50Ms: round(t.p50Ms),
		p95Ms: round(t.p95Ms),
		p99Ms: round(t.p99Ms),
		maxMs: round(t.maxMs),
		totalMs: round(t.totalMs)
	})).sort((a, b) => b.totalMs - a.totalMs);
};
var ensureMetricsConsoleHook = (repo) => {
	if (installed) return;
	installed = true;
	const api = {
		snapshot: () => repo.metrics(),
		reset: () => repo.resetMetrics(),
		print: () => {
			const snap = repo.metrics();
			console.groupCollapsed("%crepo.metrics() — counters + timings", "font-weight:bold");
			console.log("Counters:");
			console.table(counterRows(snap));
			console.log("Per-query resolve timings:");
			const qRows = timingRows(snap.queries, "query");
			if (qRows.length === 0) console.log("  (no queries dispatched yet)");
			else console.table(qRows);
			console.log("Per-DB-method timings:");
			console.table(timingRows(snap.db, "method"));
			console.groupEnd();
		},
		printQueries: () => {
			const rows = timingRows(repo.metrics().queries, "query");
			if (rows.length === 0) {
				console.log("(no queries dispatched yet)");
				return;
			}
			console.table(rows);
		},
		printDb: () => {
			console.table(timingRows(repo.metrics().db, "method"));
		}
	};
	const ns = window.__omniliner ?? {};
	ns.metrics = api;
	ns.repo = repo;
	window.__omniliner = ns;
	console.log("%c[metrics] devtools console ready", "color:#0a8", "\n  __omniliner.metrics.print() — counters + per-query + per-DB timings", "\n  __omniliner.metrics.reset() — zero everything (mark a baseline)", "\n  __omniliner.metrics.snapshot() — raw frozen object", "\n  __omniliner.repo — the Repo instance itself");
};
//#endregion
export { ensureMetricsConsoleHook };

//# sourceMappingURL=metricsConsoleHook.js.map