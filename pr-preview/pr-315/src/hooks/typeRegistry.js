import { useRepo } from "../context/repo.js";
import { useSyncExternalStore } from "react";
import { c } from "react/compiler-runtime";
//#region src/hooks/typeRegistry.ts
/** Reactive view onto `repo.types` (the merged type registry: kernel +
*  plugin + user-defined contributions). Fires on full
*  `setFacetRuntime` rebuilds AND on per-facet runtime contribution
*  updates (e.g. `UserTypesService` publishing a user-defined type).
*  Mirrors `usePropertySchemas`; the memoized subscribe matters — an
*  inline arrow would re-subscribe on every render of every consumer
*  (the supertags chip decorator wraps every block). */
var useTypes = () => {
	const $ = c(5);
	const repo = useRepo();
	let t0;
	if ($[0] !== repo) {
		t0 = (cb) => repo.onTypesChange(cb);
		$[0] = repo;
		$[1] = t0;
	} else t0 = $[1];
	const subscribe = t0;
	let t1;
	let t2;
	if ($[2] !== repo.types) {
		t1 = () => repo.types;
		t2 = () => repo.types;
		$[2] = repo.types;
		$[3] = t1;
		$[4] = t2;
	} else {
		t1 = $[3];
		t2 = $[4];
	}
	return useSyncExternalStore(subscribe, t1, t2);
};
//#endregion
export { useTypes };

//# sourceMappingURL=typeRegistry.js.map