import { appRuntimeUpdateEvent } from "../facets/runtimeEvents.js";
import { readOverridesCache } from "./overridesCache.js";
import { useEffect, useMemo, useState } from "react";
//#region src/extensions/useOverrides.ts
/**
* React hook owning the runtime-toggle overrides map for a workspace.
*
* Combines two pieces that have to move together for the toggle
* pipeline to be correct:
*
*   1. **Sync read of the localStorage cache** at mount/render — so the
*      first paint sees the user's most recent intent without waiting
*      for PowerSync to hydrate the Extensions block.
*   2. **Subscribe to `appRuntimeUpdateEvent`** — when the meta-plugin's
*      subscription effect dispatches a refresh (cache diverged from
*      the synced block), bump local state so the memo invalidates and
*      re-reads the cache.
*
* The pair is one unit because they share an invariant: every
* `refreshAppRuntime()` dispatch is meaningful exactly because the
* caller has already updated the cache. Splitting them risks a memo
* that re-runs but doesn't re-read, or a re-read that doesn't take
* effect.
*
* Returns an empty map when `workspaceId` is null/undefined — that's
* the pre-workspace boot state and matches "no overrides, use manifest
* defaults".
*/
var INITIAL_GENERATION = "initial-load";
var useOverrides = (workspaceId) => {
	const [generation, setGeneration] = useState(INITIAL_GENERATION);
	useEffect(() => {
		const reloadRuntime = (event) => {
			const detail = event.detail;
			setGeneration(detail ?? (/* @__PURE__ */ new Date()).toISOString());
		};
		window.addEventListener(appRuntimeUpdateEvent, reloadRuntime);
		return () => window.removeEventListener(appRuntimeUpdateEvent, reloadRuntime);
	}, []);
	return {
		overrides: useMemo(() => {
			if (!workspaceId) return /* @__PURE__ */ new Map();
			return readOverridesCache(workspaceId);
		}, [workspaceId, generation]),
		generation
	};
};
//#endregion
export { useOverrides };

//# sourceMappingURL=useOverrides.js.map