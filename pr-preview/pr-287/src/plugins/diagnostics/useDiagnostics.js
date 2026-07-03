import { useAppRuntime } from "../../extensions/runtimeContext.js";
import { diagnosticsFacet, worstSeverity } from "./facet.js";
import { useRef, useSyncExternalStore } from "react";
import { c } from "react/compiler-runtime";
//#region src/plugins/diagnostics/useDiagnostics.ts
/** Pure aggregation — kept out of the hook so it can be unit-tested. Sources
*  with a null snapshot (nothing to report) are dropped. */
var aggregateDiagnostics = (sources, snapshots) => {
	const items = [];
	sources.forEach((source, i) => {
		const snapshot = snapshots[i];
		if (snapshot) items.push({
			id: source.id,
			label: source.label,
			snapshot
		});
	});
	return {
		worst: worstSeverity(items.map((it) => it.snapshot.severity)),
		items
	};
};
/** Subscribe to every contributed diagnostic source and return the aggregate
*  (worst severity + per-source snapshots). The chip uses this to drive the dot
*  tone and list sources in its dropdown. */
var useDiagnostics = () => {
	const $ = c(6);
	const runtime = useAppRuntime();
	let t0;
	if ($[0] !== runtime) {
		t0 = [...runtime.read(diagnosticsFacet).values()];
		$[0] = runtime;
		$[1] = t0;
	} else t0 = $[1];
	const sources = t0;
	const cacheRef = useRef(null);
	let t1;
	if ($[2] !== sources) {
		t1 = (listener) => {
			const unsubs = sources.map((s) => s.subscribe(listener));
			return () => {
				for (const unsub of unsubs) unsub();
			};
		};
		$[2] = sources;
		$[3] = t1;
	} else t1 = $[3];
	const subscribe = t1;
	let t2;
	if ($[4] !== sources) {
		t2 = () => {
			const snaps = sources.map(_temp);
			const prev = cacheRef.current;
			if (prev && snaps.length === prev.snaps.length && snaps.every((s_1, i) => s_1 === prev.snaps[i])) return prev.aggregate;
			const aggregate = aggregateDiagnostics(sources, snaps);
			cacheRef.current = {
				snaps,
				aggregate
			};
			return aggregate;
		};
		$[4] = sources;
		$[5] = t2;
	} else t2 = $[5];
	return useSyncExternalStore(subscribe, t2);
};
function _temp(s_0) {
	return s_0.getSnapshot();
}
//#endregion
export { aggregateDiagnostics, useDiagnostics };

//# sourceMappingURL=useDiagnostics.js.map