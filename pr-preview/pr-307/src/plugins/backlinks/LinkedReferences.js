import { hasBacklinksFilter } from "./query.js";
import { useRepo } from "../../context/repo.js";
import { useManyParents, useWorkspaceId } from "../../hooks/block.js";
import { Funnel } from "../../../node_modules/lucide-react/dist/esm/icons/funnel.js";
import { useBlockOpener } from "../../utils/navigation.js";
import { BacklinksEmptyState } from "../backlinks-view/BacklinksEmptyState.js";
import { useBacklinks } from "./useBacklinks.js";
import { BacklinkFilters } from "./BacklinkFilters.js";
import { useBacklinkFilterState } from "./useStoredBacklinkFilter.js";
import { LazyBacklinkItem } from "./BacklinkEntry.js";
import { useState } from "react";
import { c } from "react/compiler-runtime";
import { Fragment as Fragment$1, jsx, jsxs } from "react/jsx-runtime";
//#region src/plugins/backlinks/LinkedReferences.tsx
function LinkedReferences(t0) {
	const $ = c(5);
	const { block, controls } = t0;
	const workspaceId = useWorkspaceId(block, useRepo().activeWorkspaceId ?? "");
	const t1 = `${workspaceId}:${block.id}`;
	let t2;
	if ($[0] !== block || $[1] !== controls || $[2] !== t1 || $[3] !== workspaceId) {
		t2 = /* @__PURE__ */ jsx(LinkedReferencesInner, {
			block,
			workspaceId,
			controls
		}, t1);
		$[0] = block;
		$[1] = controls;
		$[2] = t1;
		$[3] = workspaceId;
		$[4] = t2;
	} else t2 = $[4];
	return t2;
}
function LinkedReferencesInner(t0) {
	const $ = c(46);
	const { block, workspaceId, controls } = t0;
	const { filter, defaultFilter, effectiveFilter, defaultFilterConfigBlock, setFilter: setStoredFilter } = useBacklinkFilterState(block);
	let t1;
	if ($[0] === Symbol.for("react.memo_cache_sentinel")) {
		t1 = { plainClick: "navigator" };
		$[0] = t1;
	} else t1 = $[0];
	const openBlock = useBlockOpener(t1);
	let t2;
	if ($[1] !== effectiveFilter) {
		t2 = hasBacklinksFilter(effectiveFilter);
		$[1] = effectiveFilter;
		$[2] = t2;
	} else t2 = $[2];
	const filterActive = t2;
	const unfilteredBacklinks = useBacklinks(block, workspaceId);
	const filteredBacklinks = useBacklinks(block, workspaceId, filterActive ? effectiveFilter : void 0);
	const backlinks = filterActive ? filteredBacklinks : unfilteredBacklinks;
	const initialParentsByBacklinkId = useManyParents(backlinks);
	const [open, setOpen] = useState(true);
	const [filtersOpenOverride, setFiltersOpenOverride] = useState(null);
	const filtersOpen = filtersOpenOverride ?? filterActive;
	let t3;
	if ($[3] !== setStoredFilter) {
		t3 = (next) => {
			setStoredFilter(next);
			if (hasBacklinksFilter(next)) setFiltersOpenOverride(true);
		};
		$[3] = setStoredFilter;
		$[4] = t3;
	} else t3 = $[4];
	const setFilter = t3;
	let t4;
	if ($[5] !== defaultFilterConfigBlock.id || $[6] !== openBlock || $[7] !== workspaceId) {
		t4 = (event) => {
			openBlock(event, {
				blockId: defaultFilterConfigBlock.id,
				workspaceId
			});
		};
		$[5] = defaultFilterConfigBlock.id;
		$[6] = openBlock;
		$[7] = workspaceId;
		$[8] = t4;
	} else t4 = $[8];
	const openDefaultFilterConfig = t4;
	if (unfilteredBacklinks.length === 0) {
		let t5;
		if ($[9] !== controls) {
			t5 = /* @__PURE__ */ jsx(BacklinksEmptyState, { controls });
			$[9] = controls;
			$[10] = t5;
		} else t5 = $[10];
		return t5;
	}
	const countLabel = filterActive ? `${backlinks.length} / ${unfilteredBacklinks.length}` : String(backlinks.length);
	let t5;
	if ($[11] === Symbol.for("react.memo_cache_sentinel")) {
		t5 = () => setOpen(_temp);
		$[11] = t5;
	} else t5 = $[11];
	const t6 = open ? "▾" : "▸";
	let t7;
	if ($[12] !== t6) {
		t7 = /* @__PURE__ */ jsx("span", {
			className: "text-base leading-none",
			children: t6
		});
		$[12] = t6;
		$[13] = t7;
	} else t7 = $[13];
	let t8;
	if ($[14] === Symbol.for("react.memo_cache_sentinel")) {
		t8 = /* @__PURE__ */ jsx("span", { children: "Linked References" });
		$[14] = t8;
	} else t8 = $[14];
	let t9;
	if ($[15] !== countLabel) {
		t9 = /* @__PURE__ */ jsx("span", {
			className: "text-xs text-muted-foreground/70",
			children: countLabel
		});
		$[15] = countLabel;
		$[16] = t9;
	} else t9 = $[16];
	let t10;
	if ($[17] !== t7 || $[18] !== t9) {
		t10 = /* @__PURE__ */ jsxs("button", {
			type: "button",
			onClick: t5,
			className: "flex min-w-0 items-center gap-2 text-sm font-medium text-muted-foreground hover:text-foreground",
			children: [
				t7,
				t8,
				t9
			]
		});
		$[17] = t7;
		$[18] = t9;
		$[19] = t10;
	} else t10 = $[19];
	let t11;
	if ($[20] !== filterActive) {
		t11 = () => setFiltersOpenOverride((prev_0) => !(prev_0 ?? filterActive));
		$[20] = filterActive;
		$[21] = t11;
	} else t11 = $[21];
	const t12 = `rounded-sm p-1 text-muted-foreground hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring ${filterActive ? "bg-accent text-foreground" : ""}`;
	let t13;
	if ($[22] === Symbol.for("react.memo_cache_sentinel")) {
		t13 = /* @__PURE__ */ jsx(Funnel, { className: "h-4 w-4" });
		$[22] = t13;
	} else t13 = $[22];
	let t14;
	if ($[23] !== filtersOpen || $[24] !== t11 || $[25] !== t12) {
		t14 = /* @__PURE__ */ jsx("button", {
			type: "button",
			onClick: t11,
			className: t12,
			title: "Filters",
			"aria-label": "Filters",
			"aria-pressed": filtersOpen,
			children: t13
		});
		$[23] = filtersOpen;
		$[24] = t11;
		$[25] = t12;
		$[26] = t14;
	} else t14 = $[26];
	let t15;
	if ($[27] !== controls || $[28] !== t14) {
		t15 = /* @__PURE__ */ jsxs("div", {
			className: "flex shrink-0 items-center gap-1.5",
			children: [t14, controls]
		});
		$[27] = controls;
		$[28] = t14;
		$[29] = t15;
	} else t15 = $[29];
	let t16;
	if ($[30] !== t10 || $[31] !== t15) {
		t16 = /* @__PURE__ */ jsxs("div", {
			className: "flex items-center justify-between gap-2",
			children: [t10, t15]
		});
		$[30] = t10;
		$[31] = t15;
		$[32] = t16;
	} else t16 = $[32];
	let t17;
	if ($[33] !== backlinks || $[34] !== defaultFilter || $[35] !== filter || $[36] !== filtersOpen || $[37] !== initialParentsByBacklinkId || $[38] !== open || $[39] !== openDefaultFilterConfig || $[40] !== setFilter || $[41] !== workspaceId) {
		t17 = open && /* @__PURE__ */ jsxs(Fragment$1, { children: [filtersOpen && workspaceId && /* @__PURE__ */ jsx(BacklinkFilters, {
			workspaceId,
			filter,
			baseFilter: defaultFilter,
			baseLabel: "Daily note defaults",
			baseConfigLabel: "Open daily note defaults",
			onBaseConfigClick: openDefaultFilterConfig,
			onChange: setFilter
		}), backlinks.length === 0 ? /* @__PURE__ */ jsx("div", {
			className: "mt-3 text-xs text-muted-foreground",
			children: "No matching references."
		}) : /* @__PURE__ */ jsx("div", {
			className: "mt-3 flex flex-col gap-3",
			children: backlinks.map((backlinkBlock) => /* @__PURE__ */ jsx(LazyBacklinkItem, {
				block: backlinkBlock,
				scopeId: `flat:${backlinkBlock.id}`,
				initialParents: initialParentsByBacklinkId.get(backlinkBlock.id)
			}, backlinkBlock.id))
		})] });
		$[33] = backlinks;
		$[34] = defaultFilter;
		$[35] = filter;
		$[36] = filtersOpen;
		$[37] = initialParentsByBacklinkId;
		$[38] = open;
		$[39] = openDefaultFilterConfig;
		$[40] = setFilter;
		$[41] = workspaceId;
		$[42] = t17;
	} else t17 = $[42];
	let t18;
	if ($[43] !== t16 || $[44] !== t17) {
		t18 = /* @__PURE__ */ jsx(Fragment$1, { children: /* @__PURE__ */ jsxs("div", {
			className: "mt-4 pt-3 border-t border-border",
			children: [t16, t17]
		}) });
		$[43] = t16;
		$[44] = t17;
		$[45] = t18;
	} else t18 = $[45];
	return t18;
}
function _temp(prev) {
	return !prev;
}
//#endregion
export { LinkedReferences };

//# sourceMappingURL=LinkedReferences.js.map