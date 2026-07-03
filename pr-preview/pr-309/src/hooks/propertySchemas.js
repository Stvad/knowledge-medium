import { useRepo } from "../context/repo.js";
import { useSyncExternalStore } from "react";
import { c } from "react/compiler-runtime";
//#region src/hooks/propertySchemas.ts
/** Reactive view onto `repo.propertySchemas`. Fires on full
*  `setFacetRuntime` rebuilds AND on per-facet runtime contribution
*  updates (e.g. `UserSchemasService` adding a user-data schema). */
var usePropertySchemas = () => {
	const $ = c(5);
	const repo = useRepo();
	let t0;
	if ($[0] !== repo) {
		t0 = (cb) => repo.onPropertySchemasChange(cb);
		$[0] = repo;
		$[1] = t0;
	} else t0 = $[1];
	const subscribe = t0;
	let t1;
	let t2;
	if ($[2] !== repo.propertySchemas) {
		t1 = () => repo.propertySchemas;
		t2 = () => repo.propertySchemas;
		$[2] = repo.propertySchemas;
		$[3] = t1;
		$[4] = t2;
	} else {
		t1 = $[3];
		t2 = $[4];
	}
	return useSyncExternalStore(subscribe, t1, t2);
};
//#endregion
export { usePropertySchemas };

//# sourceMappingURL=propertySchemas.js.map