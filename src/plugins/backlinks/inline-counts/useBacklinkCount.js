import { useHandle } from "../../../hooks/block.js";
import { BACKLINKS_COUNT_FOR_BLOCK_QUERY } from "./countQuery.js";
import { c } from "react/compiler-runtime";
//#region src/plugins/backlinks/inline-counts/useBacklinkCount.ts
/** Backlink count for the inline badge. `backlinks.countForBlock` aggregates
*  in SQLite (`COUNT(*)` over the same `block_references` candidate set as
*  `backlinks.forBlock`), so it never marshals or holds the id list — a
*  heavily-referenced block costs one integer here, not a 10k-string array.
*  Membership + self-exclusion match `forBlock`, so the badge and the expanded
*  list always agree. The result is a primitive, so `useHandle`'s equality
*  bail-out re-renders the badge only when the count actually changes. */
var useBacklinkCount = (block, workspaceId) => {
	const $ = c(5);
	let t0;
	if ($[0] !== block.id || $[1] !== block.repo.query || $[2] !== workspaceId) {
		t0 = block.repo.query[BACKLINKS_COUNT_FOR_BLOCK_QUERY]({
			workspaceId,
			id: block.id
		});
		$[0] = block.id;
		$[1] = block.repo.query;
		$[2] = workspaceId;
		$[3] = t0;
	} else t0 = $[3];
	let t1;
	if ($[4] === Symbol.for("react.memo_cache_sentinel")) {
		t1 = { selector: _temp };
		$[4] = t1;
	} else t1 = $[4];
	return useHandle(t0, t1);
};
function _temp(count) {
	return count ?? 0;
}
//#endregion
export { useBacklinkCount };

//# sourceMappingURL=useBacklinkCount.js.map