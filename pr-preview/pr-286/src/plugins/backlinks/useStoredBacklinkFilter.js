import { ChangeScope } from "../../data/api/changeScope.js";
import "../../data/api/index.js";
import { hasBacklinksFilter, mergeBacklinksFilters, normalizeBacklinksFilter } from "./query.js";
import { backlinksFilterProp } from "./filterProperty.js";
import { backlinksPrefsType, dailyNoteBacklinksDefaultsProp, defaultBacklinksFilterForBlock } from "./dailyNoteDefaults.js";
import { useHandle, usePropertyValue } from "../../hooks/block.js";
import { usePluginPrefsBlock } from "../../data/globalState.js";
import { c } from "react/compiler-runtime";
//#region src/plugins/backlinks/useStoredBacklinkFilter.ts
var useStoredBacklinkFilter = (block) => {
	const $ = c(5);
	const [filter] = usePropertyValue(block, backlinksFilterProp);
	let t0;
	if ($[0] !== block) {
		t0 = (next) => {
			if (block.repo.isReadOnly) return;
			const normalized = normalizeBacklinksFilter(next);
			block.repo.tx(async (tx) => {
				const current = await tx.get(block.id);
				if (!current) return;
				const properties = { ...current.properties };
				if (hasBacklinksFilter(normalized)) properties[backlinksFilterProp.name] = backlinksFilterProp.codec.encode(normalized);
				else delete properties[backlinksFilterProp.name];
				await tx.update(block.id, { properties });
			}, {
				scope: ChangeScope.BlockDefault,
				description: "update backlinks filter"
			});
		};
		$[0] = block;
		$[1] = t0;
	} else t0 = $[1];
	const setFilter = t0;
	let t1;
	if ($[2] !== filter || $[3] !== setFilter) {
		t1 = [filter, setFilter];
		$[2] = filter;
		$[3] = setFilter;
		$[4] = t1;
	} else t1 = $[4];
	return t1;
};
var useBacklinkFilterState = (block) => {
	const $ = c(13);
	const [filter, setFilter] = useStoredBacklinkFilter(block);
	const defaultFilterConfigBlock = usePluginPrefsBlock(backlinksPrefsType);
	const [dailyNoteDefaults] = usePropertyValue(defaultFilterConfigBlock, dailyNoteBacklinksDefaultsProp);
	let t0;
	if ($[0] === Symbol.for("react.memo_cache_sentinel")) {
		t0 = { selector: _temp };
		$[0] = t0;
	} else t0 = $[0];
	const blockData = useHandle(block, t0);
	let t1;
	if ($[1] !== blockData || $[2] !== dailyNoteDefaults) {
		t1 = defaultBacklinksFilterForBlock(blockData, dailyNoteDefaults);
		$[1] = blockData;
		$[2] = dailyNoteDefaults;
		$[3] = t1;
	} else t1 = $[3];
	const defaultFilter = t1;
	let t2;
	if ($[4] !== defaultFilter || $[5] !== filter) {
		t2 = mergeBacklinksFilters(defaultFilter, filter);
		$[4] = defaultFilter;
		$[5] = filter;
		$[6] = t2;
	} else t2 = $[6];
	const effectiveFilter = t2;
	let t3;
	if ($[7] !== defaultFilter || $[8] !== defaultFilterConfigBlock || $[9] !== effectiveFilter || $[10] !== filter || $[11] !== setFilter) {
		t3 = {
			filter,
			defaultFilter,
			effectiveFilter,
			defaultFilterConfigBlock,
			setFilter
		};
		$[7] = defaultFilter;
		$[8] = defaultFilterConfigBlock;
		$[9] = effectiveFilter;
		$[10] = filter;
		$[11] = setFilter;
		$[12] = t3;
	} else t3 = $[12];
	return t3;
};
function _temp(data) {
	return data;
}
//#endregion
export { useBacklinkFilterState, useStoredBacklinkFilter };

//# sourceMappingURL=useStoredBacklinkFilter.js.map