import { hasBacklinksFilter } from "../backlinks/query.js";
import { GROUPED_BACKLINKS_FOR_BLOCK_QUERY } from "./query.js";
import { useHandle } from "../../hooks/block.js";
import { c } from "react/compiler-runtime";
//#region src/plugins/grouped-backlinks/useGroupedBacklinks.ts
var EMPTY_GROUPED_BACKLINKS = {
	groups: [],
	total: 0,
	unfilteredSourceIds: [],
	sourceParents: []
};
var useGroupedBacklinks = (block, workspaceId, groupingConfig, filter) => {
	const $ = c(8);
	const repo = block.repo;
	let t0;
	let t1;
	if ($[0] !== block.id || $[1] !== filter || $[2] !== groupingConfig || $[3] !== repo.query || $[4] !== workspaceId) {
		const args = {
			workspaceId,
			id: block.id,
			groupingConfig,
			...hasBacklinksFilter(filter) ? { filter } : {}
		};
		t0 = useHandle;
		t1 = repo.query[GROUPED_BACKLINKS_FOR_BLOCK_QUERY](args);
		$[0] = block.id;
		$[1] = filter;
		$[2] = groupingConfig;
		$[3] = repo.query;
		$[4] = workspaceId;
		$[5] = t0;
		$[6] = t1;
	} else {
		t0 = $[5];
		t1 = $[6];
	}
	let t2;
	if ($[7] === Symbol.for("react.memo_cache_sentinel")) {
		t2 = { selector: _temp };
		$[7] = t2;
	} else t2 = $[7];
	return t0(t1, t2);
};
function _temp(data) {
	return data ?? EMPTY_GROUPED_BACKLINKS;
}
//#endregion
export { useGroupedBacklinks };

//# sourceMappingURL=useGroupedBacklinks.js.map