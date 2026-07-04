import { aliasesProp, typesProp } from "../../data/properties.js";
import { uniqueStrings } from "../../utils/array.js";
import { ROAM_ISA_PROP, ROAM_PAGE_ALIAS_PROP, parsePageTokenList } from "./properties.js";
import { parseRoamImportReferences } from "./references.js";
//#region src/plugins/roam-import/typeCandidates.ts
var TYPE_CANDIDATE_EXCLUDED_PROPERTIES = new Set([
	aliasesProp.name,
	typesProp.name,
	ROAM_ISA_PROP,
	ROAM_PAGE_ALIAS_PROP
]);
var MAX_TYPE_CANDIDATES_IN_REPORT = 20;
var MAX_LOW_CONFIDENCE_TYPE_CANDIDATES_IN_REPORT = 10;
var MAX_COMMON_PROPS_IN_REPORT = 5;
var isPureTokenString = (value) => {
	return parsePageTokenList(value) !== null;
};
var collectIsaAliases = (value) => {
	if (Array.isArray(value)) return uniqueStrings(value.flatMap(collectIsaAliases));
	if (typeof value !== "string") return [];
	const trimmed = value.trim();
	if (trimmed.length === 0) return [];
	if (isPureTokenString(trimmed)) return uniqueStrings(parseRoamImportReferences(trimmed).map((ref) => ref.alias));
	return parseRoamImportReferences(trimmed).length === 0 ? [trimmed] : [];
};
var reportablePropertyNames = (properties) => Object.keys(properties).filter((name) => !TYPE_CANDIDATE_EXCLUDED_PROPERTIES.has(name) && properties[name] !== void 0);
var addTypeCandidateSource = (groups, registeredTypes, aliasIdMap, properties) => {
	const aliases = collectIsaAliases(properties[ROAM_ISA_PROP]);
	if (aliases.length === 0) return;
	const props = reportablePropertyNames(properties);
	for (const alias of aliases) {
		const targetBlockId = aliasIdMap.get(alias) ?? null;
		if (targetBlockId !== null && registeredTypes.has(targetBlockId)) continue;
		let group = groups.get(alias);
		if (!group) {
			group = {
				alias,
				targetBlockId,
				count: 0,
				propCounts: /* @__PURE__ */ new Map()
			};
			groups.set(alias, group);
		}
		group.count += 1;
		for (const prop of props) group.propCounts.set(prop, (group.propCounts.get(prop) ?? 0) + 1);
	}
};
var collectTypeCandidates = (plan, registeredTypes, aliasIdMap) => {
	const groups = /* @__PURE__ */ new Map();
	for (const page of plan.pages) addTypeCandidateSource(groups, registeredTypes, aliasIdMap, page.data?.properties ?? page.promotedFromChildren);
	for (const desc of plan.descendants) addTypeCandidateSource(groups, registeredTypes, aliasIdMap, desc.data.properties);
	return [...groups.values()].map((group) => {
		const minCommonCount = group.count === 1 ? 1 : Math.max(2, Math.ceil(group.count * .15));
		const commonProperties = [...group.propCounts.entries()].filter(([, count]) => count >= minCommonCount).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, MAX_COMMON_PROPS_IN_REPORT).map(([name, count]) => ({
			name,
			count,
			percent: Math.round(count / group.count * 100)
		}));
		return {
			alias: group.alias,
			targetBlockId: group.targetBlockId,
			count: group.count,
			commonProperties
		};
	}).sort((a, b) => b.count - a.count || a.alias.localeCompare(b.alias));
};
var typeCandidateLine = (candidate) => {
	const nodeLabel = candidate.count === 1 ? "1 node" : `${candidate.count} nodes`;
	const props = candidate.commonProperties.length > 0 ? candidate.commonProperties.map((prop) => `${prop.name} ${prop.count}/${candidate.count} (${prop.percent}%)`).join(", ") : "no recurring props";
	const idLabel = candidate.targetBlockId ?? "no live target";
	return `[[${candidate.alias}]] (${idLabel}) — ${nodeLabel}; common props: ${props}`;
};
var highConfidenceTypeCandidate = (candidate) => candidate.count >= 2 && (candidate.count >= 5 || candidate.commonProperties.length > 0);
var formatTypeCandidateLines = (candidates, max) => {
	const lines = candidates.slice(0, max).map(typeCandidateLine);
	if (candidates.length > max) lines.push(`${candidates.length - max} more isa:: candidates omitted from this report section.`);
	return lines;
};
var formatTypeCandidateReport = (candidates) => {
	const highConfidence = candidates.filter(highConfidenceTypeCandidate);
	const lowerConfidence = candidates.filter((candidate) => !highConfidenceTypeCandidate(candidate));
	const sections = [];
	if (highConfidence.length > 0) sections.push({
		title: `High-confidence (${highConfidence.length})`,
		lines: formatTypeCandidateLines(highConfidence, MAX_TYPE_CANDIDATES_IN_REPORT)
	});
	if (lowerConfidence.length > 0) sections.push({
		title: `Lower-confidence / needs review (${lowerConfidence.length})`,
		lines: formatTypeCandidateLines(lowerConfidence, MAX_LOW_CONFIDENCE_TYPE_CANDIDATES_IN_REPORT)
	});
	return sections;
};
//#endregion
export { collectTypeCandidates, formatTypeCandidateReport };

//# sourceMappingURL=typeCandidates.js.map