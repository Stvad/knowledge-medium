import { hasBacklinksFilter } from "../backlinks/query.js";
import { GROUPED_BACKLINKS_FOR_BLOCK_QUERY } from "./query.js";
import { useRepo } from "../../context/repo.js";
import { useWorkspaceId } from "../../hooks/block.js";
import { useAppRuntime } from "../../extensions/runtimeContext.js";
import { Funnel } from "../../../node_modules/lucide-react/dist/esm/icons/funnel.js";
import { Pause } from "../../../node_modules/lucide-react/dist/esm/icons/pause.js";
import { Play } from "../../../node_modules/lucide-react/dist/esm/icons/play.js";
import { useBlockOpener } from "../../utils/navigation.js";
import { groupedBacklinksGroupHeaderActionsFacet } from "./facet.js";
import { BacklinksEmptyState } from "../backlinks-view/BacklinksEmptyState.js";
import { BacklinkFilters } from "../backlinks/BacklinkFilters.js";
import { useBacklinkFilterState } from "../backlinks/useStoredBacklinkFilter.js";
import { LazyBacklinkItem } from "../backlinks/BacklinkEntry.js";
import { useGroupedBacklinksConfig } from "./useGroupedBacklinksConfig.js";
import { useGroupedBacklinks } from "./useGroupedBacklinks.js";
import { GroupHeaderActionButton } from "./GroupHeaderActionButton.js";
import { useEffect, useState } from "react";
import { c } from "react/compiler-runtime";
import { Fragment as Fragment$1, jsx, jsxs } from "react/jsx-runtime";
//#region src/plugins/grouped-backlinks/GroupedLinkedReferences.tsx
var EMPTY_GROUPED_BACKLINKS_SNAPSHOT = {
	unfilteredBacklinks: [],
	grouped: {
		groups: [],
		total: 0,
		unfilteredSourceIds: [],
		sourceParents: []
	},
	initialParentsByBacklinkId: /* @__PURE__ */ new Map()
};
var buildGroupedQueryArgs = (workspaceId, blockId, groupingConfig, effectiveFilter) => ({
	workspaceId,
	id: blockId,
	groupingConfig,
	...hasBacklinksFilter(effectiveFilter) ? { filter: effectiveFilter } : {}
});
var snapshotFromGroupedResult = (repo, grouped) => ({
	unfilteredBacklinks: grouped.unfilteredSourceIds.map((id) => repo.block(id)),
	grouped,
	initialParentsByBacklinkId: new Map(grouped.sourceParents.map((entry) => [entry.sourceId, entry.parentIds.map((parentId) => repo.block(parentId))]))
});
var GroupItems = (t0) => {
	const $ = c(22);
	const { sourceBlocks, group, parentsBySourceId } = t0;
	const headerActions = useAppRuntime().read(groupedBacklinksGroupHeaderActionsFacet);
	const [open, setOpen] = useState(true);
	const t1 = "border-l border-border/80 pl-3";
	const t2 = "flex min-w-0 items-center gap-1 py-1";
	let t3;
	if ($[0] === Symbol.for("react.memo_cache_sentinel")) {
		t3 = () => setOpen(_temp);
		$[0] = t3;
	} else t3 = $[0];
	const t4 = open ? "▾" : "▸";
	let t5;
	if ($[1] !== t4) {
		t5 = /* @__PURE__ */ jsx("span", {
			className: "text-base leading-none",
			children: t4
		});
		$[1] = t4;
		$[2] = t5;
	} else t5 = $[2];
	let t6;
	if ($[3] !== group.label) {
		t6 = /* @__PURE__ */ jsx("span", {
			className: "truncate",
			children: group.label
		});
		$[3] = group.label;
		$[4] = t6;
	} else t6 = $[4];
	let t7;
	if ($[5] !== group.sourceIds.length) {
		t7 = /* @__PURE__ */ jsx("span", {
			className: "text-xs text-muted-foreground/70",
			children: group.sourceIds.length
		});
		$[5] = group.sourceIds.length;
		$[6] = t7;
	} else t7 = $[6];
	let t8;
	if ($[7] !== t5 || $[8] !== t6 || $[9] !== t7) {
		t8 = /* @__PURE__ */ jsxs("button", {
			type: "button",
			onClick: t3,
			className: "flex min-w-0 flex-1 items-center gap-2 text-sm font-medium text-muted-foreground hover:text-foreground",
			children: [
				t5,
				t6,
				t7
			]
		});
		$[7] = t5;
		$[8] = t6;
		$[9] = t7;
		$[10] = t8;
	} else t8 = $[10];
	const t9 = headerActions.length > 0 && /* @__PURE__ */ jsx("div", {
		className: "flex shrink-0 items-center gap-0.5",
		children: headerActions.map((entry, index) => /* @__PURE__ */ jsx(GroupHeaderActionButton, {
			actionId: entry.actionId,
			sourceBlocks,
			icon: entry.icon,
			label: entry.label,
			triggerDetail: entry.triggerDetail
		}, `${entry.actionId}:${index}`))
	});
	let t10;
	if ($[11] !== t8 || $[12] !== t9) {
		t10 = /* @__PURE__ */ jsxs("div", {
			className: t2,
			children: [t8, t9]
		});
		$[11] = t8;
		$[12] = t9;
		$[13] = t10;
	} else t10 = $[13];
	let t11;
	if ($[14] !== group.groupId || $[15] !== open || $[16] !== parentsBySourceId || $[17] !== sourceBlocks) {
		t11 = open && /* @__PURE__ */ jsx("div", {
			className: "mt-1 flex flex-col gap-2",
			children: sourceBlocks.map((source) => /* @__PURE__ */ jsx(LazyBacklinkItem, {
				block: source,
				scopeId: `group:${group.groupId}:${source.id}`,
				initialParents: parentsBySourceId.get(source.id)
			}, source.id))
		});
		$[14] = group.groupId;
		$[15] = open;
		$[16] = parentsBySourceId;
		$[17] = sourceBlocks;
		$[18] = t11;
	} else t11 = $[18];
	let t12;
	if ($[19] !== t10 || $[20] !== t11) {
		t12 = /* @__PURE__ */ jsxs("div", {
			className: t1,
			children: [t10, t11]
		});
		$[19] = t10;
		$[20] = t11;
		$[21] = t12;
	} else t12 = $[21];
	return t12;
};
var GroupedReferencesGroup = (t0) => {
	const $ = c(9);
	const { group, parentsBySourceId } = t0;
	const repo = useRepo();
	let t1;
	if ($[0] !== group.sourceIds || $[1] !== repo) {
		let t2;
		if ($[3] !== repo) {
			t2 = (id) => repo.block(id);
			$[3] = repo;
			$[4] = t2;
		} else t2 = $[4];
		t1 = group.sourceIds.map(t2);
		$[0] = group.sourceIds;
		$[1] = repo;
		$[2] = t1;
	} else t1 = $[2];
	const sourceBlocks = t1;
	let t2;
	if ($[5] !== group || $[6] !== parentsBySourceId || $[7] !== sourceBlocks) {
		t2 = /* @__PURE__ */ jsx(GroupItems, {
			group,
			sourceBlocks,
			parentsBySourceId
		});
		$[5] = group;
		$[6] = parentsBySourceId;
		$[7] = sourceBlocks;
		$[8] = t2;
	} else t2 = $[8];
	return t2;
};
function GroupedLinkedReferences(t0) {
	const $ = c(5);
	const { block, controls } = t0;
	const workspaceId = useWorkspaceId(block, useRepo().activeWorkspaceId ?? "");
	const t1 = `${workspaceId}:${block.id}`;
	let t2;
	if ($[0] !== block || $[1] !== controls || $[2] !== t1 || $[3] !== workspaceId) {
		t2 = /* @__PURE__ */ jsx(GroupedLinkedReferencesInner, {
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
function GroupedLinkedReferencesInner(t0) {
	const $ = c(52);
	const { block, workspaceId, controls } = t0;
	const repo = block.repo;
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
	const groupingConfig = useGroupedBacklinksConfig(block);
	const [open, setOpen] = useState(true);
	const [filtersOpenOverride, setFiltersOpenOverride] = useState(null);
	const filtersOpen = filtersOpenOverride ?? filterActive;
	const [liveUpdates, setLiveUpdates] = useState(true);
	const [snapshot, setSnapshot] = useState(null);
	let t3;
	if ($[3] !== block.id || $[4] !== effectiveFilter || $[5] !== groupingConfig || $[6] !== workspaceId) {
		t3 = buildGroupedQueryArgs(workspaceId, block.id, groupingConfig, effectiveFilter);
		$[3] = block.id;
		$[4] = effectiveFilter;
		$[5] = groupingConfig;
		$[6] = workspaceId;
		$[7] = t3;
	} else t3 = $[7];
	const groupedArgs = t3;
	let t4;
	if ($[8] !== groupedArgs) {
		t4 = JSON.stringify(groupedArgs);
		$[8] = groupedArgs;
		$[9] = t4;
	} else t4 = $[9];
	const currentQueryKey = t4;
	let t5;
	if ($[10] !== setStoredFilter) {
		t5 = (next) => {
			setStoredFilter(next);
			if (hasBacklinksFilter(next)) setFiltersOpenOverride(true);
		};
		$[10] = setStoredFilter;
		$[11] = t5;
	} else t5 = $[11];
	const setFilter = t5;
	let t6;
	if ($[12] !== defaultFilterConfigBlock.id || $[13] !== openBlock || $[14] !== workspaceId) {
		t6 = (event) => {
			openBlock(event, {
				blockId: defaultFilterConfigBlock.id,
				workspaceId
			});
		};
		$[12] = defaultFilterConfigBlock.id;
		$[13] = openBlock;
		$[14] = workspaceId;
		$[15] = t6;
	} else t6 = $[15];
	const openDefaultFilterConfig = t6;
	let t7;
	if ($[16] !== currentQueryKey) {
		t7 = (data) => {
			setSnapshot({
				data,
				queryKey: currentQueryKey
			});
		};
		$[16] = currentQueryKey;
		$[17] = t7;
	} else t7 = $[17];
	const handleLiveData = t7;
	let t8;
	if ($[18] === Symbol.for("react.memo_cache_sentinel")) {
		t8 = () => {
			setLiveUpdates(_temp2);
		};
		$[18] = t8;
	} else t8 = $[18];
	const handleToggleLiveUpdates = t8;
	const snapshotQueryKey = snapshot?.queryKey;
	const snapshotStale = snapshotQueryKey !== void 0 && snapshotQueryKey !== currentQueryKey;
	let t10;
	let t9;
	if ($[19] !== currentQueryKey || $[20] !== groupedArgs || $[21] !== liveUpdates || $[22] !== repo || $[23] !== snapshotStale) {
		t9 = () => {
			if (liveUpdates || !snapshotStale) return;
			let cancelled = false;
			repo.query[GROUPED_BACKLINKS_FOR_BLOCK_QUERY](groupedArgs).load().then((result) => {
				if (cancelled) return;
				setSnapshot({
					data: snapshotFromGroupedResult(repo, result),
					queryKey: currentQueryKey
				});
			}, _temp3);
			return () => {
				cancelled = true;
			};
		};
		t10 = [
			liveUpdates,
			snapshotStale,
			repo,
			groupedArgs,
			currentQueryKey
		];
		$[19] = currentQueryKey;
		$[20] = groupedArgs;
		$[21] = liveUpdates;
		$[22] = repo;
		$[23] = snapshotStale;
		$[24] = t10;
		$[25] = t9;
	} else {
		t10 = $[24];
		t9 = $[25];
	}
	useEffect(t9, t10);
	let t11;
	if ($[26] !== block || $[27] !== controls || $[28] !== defaultFilter || $[29] !== filter || $[30] !== filterActive || $[31] !== filtersOpen || $[32] !== open || $[33] !== openDefaultFilterConfig || $[34] !== setFilter || $[35] !== workspaceId) {
		t11 = {
			block,
			workspaceId,
			controls,
			open,
			setOpen,
			filter,
			defaultFilter,
			filterActive,
			filtersOpen,
			setFiltersOpenOverride,
			setFilter,
			openDefaultFilterConfig
		};
		$[26] = block;
		$[27] = controls;
		$[28] = defaultFilter;
		$[29] = filter;
		$[30] = filterActive;
		$[31] = filtersOpen;
		$[32] = open;
		$[33] = openDefaultFilterConfig;
		$[34] = setFilter;
		$[35] = workspaceId;
		$[36] = t11;
	} else t11 = $[36];
	const shared = t11;
	const data_0 = snapshot?.data ?? EMPTY_GROUPED_BACKLINKS_SNAPSHOT;
	let t12;
	if ($[37] !== data_0 || $[38] !== liveUpdates || $[39] !== shared) {
		t12 = /* @__PURE__ */ jsx(GroupedReferencesView, {
			...shared,
			data: data_0,
			liveUpdates,
			onToggleLiveUpdates: handleToggleLiveUpdates
		});
		$[37] = data_0;
		$[38] = liveUpdates;
		$[39] = shared;
		$[40] = t12;
	} else t12 = $[40];
	let t13;
	if ($[41] !== block || $[42] !== effectiveFilter || $[43] !== filterActive || $[44] !== groupingConfig || $[45] !== handleLiveData || $[46] !== liveUpdates || $[47] !== workspaceId) {
		t13 = liveUpdates && /* @__PURE__ */ jsx(GroupedBacklinksLiveBridge, {
			block,
			workspaceId,
			groupingConfig,
			filter: filterActive ? effectiveFilter : void 0,
			onData: handleLiveData
		});
		$[41] = block;
		$[42] = effectiveFilter;
		$[43] = filterActive;
		$[44] = groupingConfig;
		$[45] = handleLiveData;
		$[46] = liveUpdates;
		$[47] = workspaceId;
		$[48] = t13;
	} else t13 = $[48];
	let t14;
	if ($[49] !== t12 || $[50] !== t13) {
		t14 = /* @__PURE__ */ jsxs(Fragment$1, { children: [t12, t13] });
		$[49] = t12;
		$[50] = t13;
		$[51] = t14;
	} else t14 = $[51];
	return t14;
}
function _temp3() {}
function _temp2(prev) {
	return !prev;
}
function GroupedBacklinksLiveBridge(t0) {
	const $ = c(7);
	const { block, workspaceId, groupingConfig, filter, onData } = t0;
	const grouped = useGroupedBacklinks(block, workspaceId, groupingConfig, filter);
	let t1;
	if ($[0] !== block.repo || $[1] !== grouped) {
		t1 = snapshotFromGroupedResult(block.repo, grouped);
		$[0] = block.repo;
		$[1] = grouped;
		$[2] = t1;
	} else t1 = $[2];
	const data = t1;
	let t2;
	let t3;
	if ($[3] !== data || $[4] !== onData) {
		t2 = () => {
			onData(data);
		};
		t3 = [onData, data];
		$[3] = data;
		$[4] = onData;
		$[5] = t2;
		$[6] = t3;
	} else {
		t2 = $[5];
		t3 = $[6];
	}
	useEffect(t2, t3);
	return null;
}
function GroupedReferencesView(t0) {
	const $ = c(51);
	const { workspaceId, controls, data, liveUpdates, onToggleLiveUpdates, open, setOpen, filter, defaultFilter, filterActive, filtersOpen, setFiltersOpenOverride, setFilter, openDefaultFilterConfig } = t0;
	const { unfilteredBacklinks, grouped, initialParentsByBacklinkId } = data;
	if (unfilteredBacklinks.length === 0) {
		let t1;
		if ($[0] !== controls) {
			t1 = /* @__PURE__ */ jsx(BacklinksEmptyState, { controls });
			$[0] = controls;
			$[1] = t1;
		} else t1 = $[1];
		return t1;
	}
	const countLabel = filterActive ? `${grouped.total} / ${unfilteredBacklinks.length}` : String(grouped.total);
	let t1;
	if ($[2] !== setOpen) {
		t1 = () => setOpen(_temp4);
		$[2] = setOpen;
		$[3] = t1;
	} else t1 = $[3];
	const t2 = open ? "▾" : "▸";
	let t3;
	if ($[4] !== t2) {
		t3 = /* @__PURE__ */ jsx("span", {
			className: "text-base leading-none",
			children: t2
		});
		$[4] = t2;
		$[5] = t3;
	} else t3 = $[5];
	let t4;
	if ($[6] === Symbol.for("react.memo_cache_sentinel")) {
		t4 = /* @__PURE__ */ jsx("span", { children: "Grouped References" });
		$[6] = t4;
	} else t4 = $[6];
	let t5;
	if ($[7] !== countLabel) {
		t5 = /* @__PURE__ */ jsx("span", {
			className: "text-xs text-muted-foreground/70",
			children: countLabel
		});
		$[7] = countLabel;
		$[8] = t5;
	} else t5 = $[8];
	let t6;
	if ($[9] !== t1 || $[10] !== t3 || $[11] !== t5) {
		t6 = /* @__PURE__ */ jsxs("button", {
			type: "button",
			onClick: t1,
			className: "flex min-w-0 items-center gap-2 text-sm font-medium text-muted-foreground hover:text-foreground",
			children: [
				t3,
				t4,
				t5
			]
		});
		$[9] = t1;
		$[10] = t3;
		$[11] = t5;
		$[12] = t6;
	} else t6 = $[12];
	const t7 = `rounded-sm p-1 text-muted-foreground hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring ${!liveUpdates ? "bg-accent text-foreground" : ""}`;
	const t8 = liveUpdates ? "Pause live updates" : "Resume live updates";
	const t9 = liveUpdates ? "Pause live updates" : "Resume live updates";
	const t10 = !liveUpdates;
	let t11;
	if ($[13] !== liveUpdates) {
		t11 = liveUpdates ? /* @__PURE__ */ jsx(Pause, { className: "h-4 w-4" }) : /* @__PURE__ */ jsx(Play, { className: "h-4 w-4" });
		$[13] = liveUpdates;
		$[14] = t11;
	} else t11 = $[14];
	let t12;
	if ($[15] !== onToggleLiveUpdates || $[16] !== t10 || $[17] !== t11 || $[18] !== t7 || $[19] !== t8 || $[20] !== t9) {
		t12 = /* @__PURE__ */ jsx("button", {
			type: "button",
			onClick: onToggleLiveUpdates,
			className: t7,
			title: t8,
			"aria-label": t9,
			"aria-pressed": t10,
			children: t11
		});
		$[15] = onToggleLiveUpdates;
		$[16] = t10;
		$[17] = t11;
		$[18] = t7;
		$[19] = t8;
		$[20] = t9;
		$[21] = t12;
	} else t12 = $[21];
	let t13;
	if ($[22] !== filterActive || $[23] !== setFiltersOpenOverride) {
		t13 = () => setFiltersOpenOverride((prev_0) => !(prev_0 ?? filterActive));
		$[22] = filterActive;
		$[23] = setFiltersOpenOverride;
		$[24] = t13;
	} else t13 = $[24];
	const t14 = `rounded-sm p-1 text-muted-foreground hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring ${filterActive ? "bg-accent text-foreground" : ""}`;
	let t15;
	if ($[25] === Symbol.for("react.memo_cache_sentinel")) {
		t15 = /* @__PURE__ */ jsx(Funnel, { className: "h-4 w-4" });
		$[25] = t15;
	} else t15 = $[25];
	let t16;
	if ($[26] !== filtersOpen || $[27] !== t13 || $[28] !== t14) {
		t16 = /* @__PURE__ */ jsx("button", {
			type: "button",
			onClick: t13,
			className: t14,
			title: "Filters",
			"aria-label": "Filters",
			"aria-pressed": filtersOpen,
			children: t15
		});
		$[26] = filtersOpen;
		$[27] = t13;
		$[28] = t14;
		$[29] = t16;
	} else t16 = $[29];
	let t17;
	if ($[30] !== controls || $[31] !== t12 || $[32] !== t16) {
		t17 = /* @__PURE__ */ jsxs("div", {
			className: "flex shrink-0 items-center gap-1.5",
			children: [
				t12,
				t16,
				controls
			]
		});
		$[30] = controls;
		$[31] = t12;
		$[32] = t16;
		$[33] = t17;
	} else t17 = $[33];
	let t18;
	if ($[34] !== t17 || $[35] !== t6) {
		t18 = /* @__PURE__ */ jsxs("div", {
			className: "flex items-center justify-between gap-2",
			children: [t6, t17]
		});
		$[34] = t17;
		$[35] = t6;
		$[36] = t18;
	} else t18 = $[36];
	let t19;
	if ($[37] !== defaultFilter || $[38] !== filter || $[39] !== filtersOpen || $[40] !== grouped.groups || $[41] !== grouped.total || $[42] !== initialParentsByBacklinkId || $[43] !== open || $[44] !== openDefaultFilterConfig || $[45] !== setFilter || $[46] !== workspaceId) {
		t19 = open && /* @__PURE__ */ jsxs(Fragment$1, { children: [filtersOpen && workspaceId && /* @__PURE__ */ jsx(BacklinkFilters, {
			workspaceId,
			filter,
			baseFilter: defaultFilter,
			baseLabel: "Daily note defaults",
			baseConfigLabel: "Open daily note defaults",
			onBaseConfigClick: openDefaultFilterConfig,
			onChange: setFilter
		}), grouped.total === 0 ? /* @__PURE__ */ jsx("div", {
			className: "mt-3 text-xs text-muted-foreground",
			children: "No matching references."
		}) : /* @__PURE__ */ jsx("div", {
			className: "mt-3 flex flex-col gap-4",
			children: grouped.groups.map((group) => /* @__PURE__ */ jsx(GroupedReferencesGroup, {
				group,
				parentsBySourceId: initialParentsByBacklinkId
			}, group.groupId))
		})] });
		$[37] = defaultFilter;
		$[38] = filter;
		$[39] = filtersOpen;
		$[40] = grouped.groups;
		$[41] = grouped.total;
		$[42] = initialParentsByBacklinkId;
		$[43] = open;
		$[44] = openDefaultFilterConfig;
		$[45] = setFilter;
		$[46] = workspaceId;
		$[47] = t19;
	} else t19 = $[47];
	let t20;
	if ($[48] !== t18 || $[49] !== t19) {
		t20 = /* @__PURE__ */ jsx(Fragment$1, { children: /* @__PURE__ */ jsxs("div", {
			className: "mt-4 pt-3 border-t border-border",
			children: [t18, t19]
		}) });
		$[48] = t18;
		$[49] = t19;
		$[50] = t20;
	} else t20 = $[50];
	return t20;
}
function _temp4(prev) {
	return !prev;
}
function _temp(prev) {
	return !prev;
}
//#endregion
export { GroupedLinkedReferences };

//# sourceMappingURL=GroupedLinkedReferences.js.map