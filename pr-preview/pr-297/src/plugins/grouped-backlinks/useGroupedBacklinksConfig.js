import { groupedBacklinksDefaultsProp, groupedBacklinksPrefsType, mergeGroupedBacklinksConfig, selectGroupedBacklinksOverrides } from "./config.js";
import { useHandle } from "../../hooks/block.js";
import { usePluginPrefsProperty } from "../../data/globalState.js";
import { c } from "react/compiler-runtime";
//#region src/plugins/grouped-backlinks/useGroupedBacklinksConfig.ts
var useGroupedBacklinksConfig = (block) => {
	const $ = c(4);
	const [defaults] = usePluginPrefsProperty(groupedBacklinksPrefsType, groupedBacklinksDefaultsProp);
	let t0;
	if ($[0] === Symbol.for("react.memo_cache_sentinel")) {
		t0 = { selector: selectGroupedBacklinksOverrides };
		$[0] = t0;
	} else t0 = $[0];
	const overrides = useHandle(block, t0);
	let t1;
	if ($[1] !== defaults || $[2] !== overrides) {
		t1 = mergeGroupedBacklinksConfig(defaults, overrides);
		$[1] = defaults;
		$[2] = overrides;
		$[3] = t1;
	} else t1 = $[3];
	return t1;
};
//#endregion
export { useGroupedBacklinksConfig };

//# sourceMappingURL=useGroupedBacklinksConfig.js.map