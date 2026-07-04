import { useRepo } from "../../context/repo.js";
import { useBlockQuery, useHandle } from "../../hooks/block.js";
import { buildDueCardsQuery } from "./dueQuery.js";
import { useEffect, useState } from "react";
import { c } from "react/compiler-runtime";
//#region src/plugins/srs-review/useDueCards.ts
var startOfLocalDay = (now = /* @__PURE__ */ new Date()) => new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
/** Local-midnight timestamp for today, advanced when the date rolls
*  over. Polls once a minute (cheap, and only re-renders on the minute
*  the day actually changes) so a deck left open overnight refreshes its
*  due cutoff instead of staying pinned to yesterday. */
var useStartOfToday = () => {
	const $ = c(2);
	const [ts, setTs] = useState(startOfLocalDay);
	let t0;
	let t1;
	if ($[0] === Symbol.for("react.memo_cache_sentinel")) {
		t0 = () => {
			const id = setInterval(() => {
				const next = startOfLocalDay();
				setTs((prev) => prev === next ? prev : next);
			}, 6e4);
			return () => clearInterval(id);
		};
		t1 = [];
		$[0] = t0;
		$[1] = t1;
	} else {
		t0 = $[0];
		t1 = $[1];
	}
	useEffect(t0, t1);
	return ts;
};
/** Shared query builder for the due-cards hooks, so `useDueCards` and
*  `useDueCardsReady` observe the exact same typed-blocks handle.
*
*  A non-empty `tagName` is resolved to its page block id via
*  `core.aliasLookup`; when the page doesn't exist the deck targets
*  `UNRESOLVED_TAG_ID` so it reports zero rather than every due card.
*  An empty `tagName` is the "all due" deck (no tag filter). */
var useDueCardsQuery = (workspaceId, tagName) => {
	const $ = c(11);
	const repo = useRepo();
	let t0;
	let t1;
	let wantsTag;
	if ($[0] !== repo.query || $[1] !== tagName || $[2] !== workspaceId) {
		const alias = tagName.trim();
		wantsTag = alias.length > 0;
		t0 = useHandle;
		t1 = repo.query.aliasLookup({
			workspaceId,
			alias: wantsTag ? alias : ""
		});
		$[0] = repo.query;
		$[1] = tagName;
		$[2] = workspaceId;
		$[3] = t0;
		$[4] = t1;
		$[5] = wantsTag;
	} else {
		t0 = $[3];
		t1 = $[4];
		wantsTag = $[5];
	}
	let t2;
	if ($[6] === Symbol.for("react.memo_cache_sentinel")) {
		t2 = { selector: _temp };
		$[6] = t2;
	} else t2 = $[6];
	const resolvedId = t0(t1, t2);
	const tagBlockId = wantsTag ? resolvedId ?? "srs-review:unresolved-tag" : null;
	const startOfToday = useStartOfToday();
	let t3;
	if ($[7] !== startOfToday || $[8] !== tagBlockId || $[9] !== workspaceId) {
		t3 = buildDueCardsQuery({
			workspaceId,
			tagBlockId,
			now: new Date(startOfToday)
		});
		$[7] = startOfToday;
		$[8] = tagBlockId;
		$[9] = workspaceId;
		$[10] = t3;
	} else t3 = $[10];
	return t3;
};
/** Reactive list of SRS cards due today or earlier for a deck. */
var useDueCards = (workspaceId, tagName) => {
	return useBlockQuery(useDueCardsQuery(workspaceId, tagName));
};
/** Whether the due-cards query has produced a result yet (vs. still
*  loading). A loaded-but-empty deck reports `true` here while
*  `useDueCards` returns `[]`, letting callers tell "nothing due" apart
*  from "not loaded yet" — the query handle's data is `undefined` until
*  the first resolve, then an array (possibly empty). Shares the handle
*  with `useDueCards`, so it adds no extra query. */
var useDueCardsReady = (workspaceId, tagName) => {
	const $ = c(4);
	const repo = useRepo();
	const query = useDueCardsQuery(workspaceId, tagName);
	let t0;
	if ($[0] !== query || $[1] !== repo.query) {
		t0 = repo.query.typedBlocks(query);
		$[0] = query;
		$[1] = repo.query;
		$[2] = t0;
	} else t0 = $[2];
	let t1;
	if ($[3] === Symbol.for("react.memo_cache_sentinel")) {
		t1 = { selector: _temp2 };
		$[3] = t1;
	} else t1 = $[3];
	return useHandle(t0, t1);
};
function _temp(data) {
	return data ? data.id : null;
}
function _temp2(data) {
	return data !== void 0;
}
//#endregion
export { useDueCards, useDueCardsReady };

//# sourceMappingURL=useDueCards.js.map