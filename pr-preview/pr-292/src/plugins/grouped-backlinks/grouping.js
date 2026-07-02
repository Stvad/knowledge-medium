import { EMPTY_GROUPED_BACKLINKS_CONFIG, normalizeGroupedBacklinksConfig } from "./config.js";
//#region src/plugins/grouped-backlinks/grouping.ts
var FALLBACK_GROUP_ID = "__grouped_backlinks_other__";
var FALLBACK_GROUP_LABEL = "Other";
var toSet = (values) => new Set(values.map((value) => value.trim()).filter(Boolean));
var toRegExp = (pattern) => {
	try {
		return new RegExp(pattern);
	} catch {
		return null;
	}
};
var buildMatcher = (config) => ({
	highPriorityTags: toSet(config.highPriorityTags),
	lowPriorityTags: toSet(config.lowPriorityTags),
	excludedTags: toSet(config.excludedTags),
	excludedPatterns: config.excludedPatterns.map(toRegExp).filter((pattern) => pattern !== null)
});
var matchesAnyPattern = (label, patterns) => patterns.some((pattern) => pattern.test(label));
var classify = (candidate, matcher) => {
	if (matcher.highPriorityTags.has(candidate.groupLabel)) return "high";
	if (candidate.kind === "root" || matcher.lowPriorityTags.has(candidate.groupLabel)) return "low";
	return "default";
};
var labelExcluded = (label, matcher) => !label.trim() || matcher.excludedTags.has(label) || matchesAnyPattern(label, matcher.excludedPatterns);
var priorityRank = (priority) => {
	switch (priority) {
		case "high": return 3;
		case "default": return 2;
		case "low": return 1;
	}
};
var orderedMembers = (group, sourceOrder, consumed) => sourceOrder.filter((id) => group.sourceIds.has(id) && !consumed.has(id));
var pickLargestGroup = (groups, sourceOrder, consumed, minSize) => {
	let best = null;
	for (const group of groups) {
		const members = orderedMembers(group, sourceOrder, consumed);
		if (members.length < minSize) continue;
		if (!best || members.length > best.members.length) best = {
			group,
			members
		};
	}
	return best;
};
var buildGroupedBacklinks = ({ targetId, sourceOrder, candidates, groupingConfig = EMPTY_GROUPED_BACKLINKS_CONFIG, minGroupSize = 2 }) => {
	const sourceSet = new Set(sourceOrder);
	const matcher = buildMatcher(normalizeGroupedBacklinksConfig(groupingConfig));
	const groups = /* @__PURE__ */ new Map();
	for (const candidate of candidates) {
		if (candidate.groupId === targetId || !sourceSet.has(candidate.sourceId) || labelExcluded(candidate.groupLabel, matcher)) continue;
		const priority = classify(candidate, matcher);
		const existing = groups.get(candidate.groupId);
		if (existing) {
			existing.sourceIds.add(candidate.sourceId);
			if (priorityRank(priority) > priorityRank(existing.priority)) existing.priority = priority;
			continue;
		}
		groups.set(candidate.groupId, {
			groupId: candidate.groupId,
			label: candidate.groupLabel,
			sourceIds: new Set([candidate.sourceId]),
			priority,
			kind: candidate.kind
		});
	}
	const consumed = /* @__PURE__ */ new Set();
	const result = [];
	const fieldGroupsByPriority = /* @__PURE__ */ new Map();
	const fieldGroups = Array.from(groups.values()).filter((group) => group.kind === "field").sort((a, b) => a.label.localeCompare(b.label));
	for (const group of fieldGroups) {
		const members = orderedMembers(group, sourceOrder, /* @__PURE__ */ new Set());
		if (members.length === 0) continue;
		const priorityGroups = fieldGroupsByPriority.get(group.priority) ?? [];
		priorityGroups.push(group);
		fieldGroupsByPriority.set(group.priority, priorityGroups);
		for (const id of members) consumed.add(id);
	}
	const consumePriority = (priority) => {
		const minSize = priority === "high" ? 1 : minGroupSize;
		const priorityGroups = Array.from(groups.values()).filter((group) => group.priority === priority && group.kind !== "field");
		while (priorityGroups.length > 0) {
			const picked = pickLargestGroup(priorityGroups, sourceOrder, consumed, minSize);
			if (!picked) return;
			result.push({
				groupId: picked.group.groupId,
				label: picked.group.label,
				sourceIds: picked.members,
				fallback: false
			});
			for (const id of picked.members) consumed.add(id);
			const idx = priorityGroups.indexOf(picked.group);
			if (idx >= 0) priorityGroups.splice(idx, 1);
		}
	};
	const emitFieldGroups = (priority) => {
		for (const group of fieldGroupsByPriority.get(priority) ?? []) {
			const members = orderedMembers(group, sourceOrder, /* @__PURE__ */ new Set());
			result.push({
				groupId: group.groupId,
				label: group.label,
				sourceIds: members,
				fallback: false
			});
		}
	};
	for (const priority of [
		"high",
		"default",
		"low"
	]) {
		consumePriority(priority);
		emitFieldGroups(priority);
	}
	const fallbackIds = sourceOrder.filter((id) => !consumed.has(id));
	if (fallbackIds.length > 0) result.push({
		groupId: FALLBACK_GROUP_ID,
		label: FALLBACK_GROUP_LABEL,
		sourceIds: fallbackIds,
		fallback: true
	});
	return result;
};
//#endregion
export { FALLBACK_GROUP_ID, FALLBACK_GROUP_LABEL, buildGroupedBacklinks };

//# sourceMappingURL=grouping.js.map