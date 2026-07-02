import { dailyNoteBlockId } from "../daily-notes/dailyNotes.js";
import { parseLiteralDailyPageTitle } from "../../utils/relativeDate.js";
import { srsArchivedProp, srsFactorProp, srsIntervalProp, srsNextReviewDateProp, srsReviewCountProp } from "../srs-rescheduling/schema.js";
import "../daily-notes/index.js";
import { extractRoamTodoMarker, stripRoamTodoContent } from "./todo.js";
import { parseRoamImportReferences } from "./references.js";
//#region src/plugins/roam-import/srsMarkers.ts
var escapeRegExp = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
var roamInlinePropertyValue = (text, name) => {
	return new RegExp(`\\[\\[\\[\\[${escapeRegExp(name)}\\]\\]::?([^\\]]+)\\]\\]`).exec(text)?.[1]?.trim();
};
var ROAM_SRS_INLINE_PROPERTY_RE = /\[\[\[\[(interval|factor)\]\]::?[^\]]+\]\]/gi;
var ROAM_HASH_PAGE_RE = /(^|[^\w/:])#\[\[[^\]]+\]\]/g;
var REVIEW_STAR_RE = /(?:^|\s)\*(?=\s|$)/g;
var countReviewStars = (text) => {
	return text.match(REVIEW_STAR_RE)?.length ?? 0;
};
var hasFiniteRoamInlineNumber = (rawContent, name) => Number.isFinite(Number.parseFloat(roamInlinePropertyValue(rawContent, name) ?? ""));
var hasDoneMarker = (rawContent) => extractRoamTodoMarker(rawContent).todoState === "DONE" || parseRoamImportReferences(rawContent).some((ref) => ref.alias === "DONE");
var hasSrsScheduleFields = (rawContent) => hasFiniteRoamInlineNumber(rawContent, "interval") && hasFiniteRoamInlineNumber(rawContent, "factor");
var hasSrsScheduleDate = (rawContent) => parseRoamImportReferences(rawContent).some((ref) => parseLiteralDailyPageTitle(ref.alias) !== null);
var extractSrsScheduleMarker = (rawContent, workspaceId) => {
	const interval = Number.parseFloat(roamInlinePropertyValue(rawContent, "interval") ?? "");
	const factor = Number.parseFloat(roamInlinePropertyValue(rawContent, "factor") ?? "");
	if (!Number.isFinite(interval) || !Number.isFinite(factor)) return null;
	const reviewCount = countReviewStars(rawContent);
	const dateRef = parseRoamImportReferences(rawContent).map((ref) => ({
		ref,
		parsed: parseLiteralDailyPageTitle(ref.alias)
	})).find((item) => item.parsed !== null);
	if (!dateRef?.parsed) return null;
	return {
		interval,
		factor,
		nextReviewDateAlias: dateRef.ref.alias,
		nextReviewDateId: dailyNoteBlockId(workspaceId, dateRef.parsed.iso),
		reviewCount,
		...hasDoneMarker(rawContent) ? { archived: true } : {}
	};
};
var scheduleDueIso = (schedule) => parseLiteralDailyPageTitle(schedule.nextReviewDateAlias)?.iso ?? "";
var removeParsedDateRefs = (content) => {
	const refs = parseRoamImportReferences(content).filter((ref) => parseLiteralDailyPageTitle(ref.alias) !== null).sort((a, b) => b.startIndex - a.startIndex);
	let out = content;
	for (const ref of refs) out = out.slice(0, ref.startIndex) + out.slice(ref.endIndex);
	return out;
};
var removePageRefs = (content) => {
	const refs = parseRoamImportReferences(content).sort((a, b) => b.startIndex - a.startIndex);
	let out = content;
	for (const ref of refs) out = out.slice(0, ref.startIndex) + out.slice(ref.endIndex);
	return out;
};
var srsScheduleMarkerResidue = (rawContent) => removePageRefs(removeParsedDateRefs(stripRoamTodoContent(rawContent)).replace(ROAM_SRS_INLINE_PROPERTY_RE, " ").replace(ROAM_HASH_PAGE_RE, " ").replace(/(^|[^\w/:])#[\w/-]+/g, " ")).replace(REVIEW_STAR_RE, " ").replace(/\s+/g, " ").trim();
var isSrsScheduleMarkerOnly = (rawContent) => extractSrsScheduleMarker(rawContent, "00000000-0000-4000-8000-000000000000") !== null && srsScheduleMarkerResidue(rawContent).length === 0;
var stripSrsScheduleMetadataFromValue = (rawContent) => rawContent.replace(ROAM_SRS_INLINE_PROPERTY_RE, " ").replace(REVIEW_STAR_RE, " ").replace(/\s+/g, " ").trim();
var findPromotedSrsScheduleInChildren = (children, workspaceId, parentUid) => {
	const markerOnlyChildren = [];
	for (const child of children) {
		const schedule = extractSrsScheduleMarker(child.string ?? "", workspaceId);
		if (schedule && isSrsScheduleMarkerOnly(child.string ?? "")) markerOnlyChildren.push({
			child,
			schedule
		});
	}
	const canonical = markerOnlyChildren.reduce((latest, candidate) => latest && scheduleDueIso(latest.schedule) >= scheduleDueIso(candidate.schedule) ? latest : candidate, void 0);
	const diagnostics = markerOnlyChildren.length > 1 ? [`Multiple marker-only Roam SRS children under uid ${parentUid}; promoted latest due date ${canonical?.schedule.nextReviewDateAlias ?? "unknown"} (${canonical?.child.uid ?? markerOnlyChildren[0].child.uid}) and preserved ${markerOnlyChildren.length - 1} additional marker block(s) literally.`] : [];
	return {
		schedule: canonical?.schedule,
		diagnostics
	};
};
var propertiesFromSrsSchedule = (schedule) => {
	if (!schedule) return {};
	return {
		[srsIntervalProp.name]: schedule.interval,
		[srsFactorProp.name]: schedule.factor,
		[srsNextReviewDateProp.name]: schedule.nextReviewDateId,
		[srsReviewCountProp.name]: schedule.reviewCount,
		...schedule.archived ? { [srsArchivedProp.name]: true } : {}
	};
};
//#endregion
export { extractSrsScheduleMarker, findPromotedSrsScheduleInChildren, hasSrsScheduleDate, hasSrsScheduleFields, isSrsScheduleMarkerOnly, propertiesFromSrsSchedule, srsScheduleMarkerResidue, stripSrsScheduleMetadataFromValue };

//# sourceMappingURL=srsMarkers.js.map