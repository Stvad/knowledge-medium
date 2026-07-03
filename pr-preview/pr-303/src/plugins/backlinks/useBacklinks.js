import { BACKLINKS_FOR_BLOCK_QUERY, hasBacklinksFilter } from "./query.js";
import { useHandle } from "../../hooks/block.js";
import { c } from "react/compiler-runtime";
//#region src/plugins/backlinks/useBacklinks.ts
var EMPTY_STRING_ARRAY = Object.freeze([]);
/** Reactive backlinks for a block in its workspace. */
var useBacklinks = (block, workspaceId, filter) => {
	const $ = c(8);
	const repo = block.repo;
	let t0;
	let t1;
	if ($[0] !== block.id || $[1] !== filter || $[2] !== repo.query || $[3] !== workspaceId) {
		const args = hasBacklinksFilter(filter) ? {
			workspaceId,
			id: block.id,
			filter
		} : {
			workspaceId,
			id: block.id
		};
		t0 = useHandle;
		t1 = repo.query[BACKLINKS_FOR_BLOCK_QUERY](args);
		$[0] = block.id;
		$[1] = filter;
		$[2] = repo.query;
		$[3] = workspaceId;
		$[4] = t0;
		$[5] = t1;
	} else {
		t0 = $[4];
		t1 = $[5];
	}
	let t2;
	if ($[6] !== repo) {
		t2 = { selector: (data) => (data ?? EMPTY_STRING_ARRAY).map((id) => repo.block(id)) };
		$[6] = repo;
		$[7] = t2;
	} else t2 = $[7];
	return t0(t1, t2);
};
//#endregion
export { useBacklinks };

//# sourceMappingURL=useBacklinks.js.map