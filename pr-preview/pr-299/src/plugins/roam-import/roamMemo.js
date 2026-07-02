import { dailyNoteBlockId } from "../daily-notes/dailyNotes.js";
import { parseLiteralDailyPageTitle } from "../../utils/relativeDate.js";
import { srsArchivedProp, srsFactorProp, srsGradeProp, srsIntervalProp, srsNextReviewDateProp, srsReviewCountProp, srsSnapshotHistoryProp } from "../srs-rescheduling/schema.js";
import "../daily-notes/index.js";
import { parseRoamImportReferences } from "./references.js";
import { detectInlineAttribute } from "./promotion.js";
//#region src/plugins/roam-import/roamMemo.ts
var blockRefUidFromContent = (content) => {
	return /^\s*\(\(([^)]+)\)\)\s*$/.exec(content ?? "")?.[1]?.trim();
};
var pageRefAliasFromContent = (content) => {
	return /^\s*\[\[([^\]]+)\]\]\s*$/.exec(content ?? "")?.[1]?.trim();
};
var numberFromMemoField = (value) => {
	if (value === void 0) return void 0;
	const n = Number.parseFloat(value);
	return Number.isFinite(n) ? n : void 0;
};
var firstDailyAliasInValue = (value) => {
	if (!value) return void 0;
	for (const ref of parseRoamImportReferences(value)) {
		const parsed = parseLiteralDailyPageTitle(ref.alias);
		if (parsed) return {
			alias: ref.alias,
			iso: parsed.iso
		};
	}
};
var parseRoamMemoSession = (block, workspaceId) => {
	const reviewedAtAlias = /^\s*\[\[([^\]]+)\]\]/.exec(block.string ?? "")?.[1]?.trim();
	if (!reviewedAtAlias) return null;
	const reviewedAt = parseLiteralDailyPageTitle(reviewedAtAlias);
	if (!reviewedAt) return null;
	const fields = /* @__PURE__ */ new Map();
	for (const child of block.children ?? []) {
		const attr = detectInlineAttribute(child.string);
		if (attr) fields.set(attr.key, attr.value.trim());
	}
	const reviewMode = fields.get("reviewMode");
	if (reviewMode && reviewMode !== "SPACED_INTERVAL") return null;
	const grade = numberFromMemoField(fields.get("grade"));
	const interval = numberFromMemoField(fields.get("interval"));
	const factor = numberFromMemoField(fields.get("eFactor"));
	const reviewCount = numberFromMemoField(fields.get("repetitions"));
	const nextReviewDate = firstDailyAliasInValue(fields.get("nextDueDate"));
	if (grade === void 0 || interval === void 0 || factor === void 0 || reviewCount === void 0 || !nextReviewDate) return null;
	return {
		reviewedAt: dailyNoteBlockId(workspaceId, reviewedAt.iso),
		reviewedAtAlias,
		reviewedAtIso: reviewedAt.iso,
		grade,
		interval,
		factor,
		reviewCount,
		nextReviewDateAlias: nextReviewDate.alias,
		nextReviewDateId: dailyNoteBlockId(workspaceId, nextReviewDate.iso)
	};
};
var storedSnapshot = (snapshot) => ({
	reviewedAt: snapshot.reviewedAt,
	grade: snapshot.grade,
	interval: snapshot.interval,
	factor: snapshot.factor,
	reviewCount: snapshot.reviewCount
});
var propertiesFromRoamMemo = (entry) => {
	if (!entry) return {};
	const latest = entry.snapshots.at(-1);
	const out = {};
	if (latest) {
		out[srsIntervalProp.name] = latest.interval;
		out[srsFactorProp.name] = latest.factor;
		out[srsNextReviewDateProp.name] = latest.nextReviewDateId;
		out[srsReviewCountProp.name] = latest.reviewCount;
		out[srsGradeProp.name] = latest.grade;
		out[srsSnapshotHistoryProp.name] = srsSnapshotHistoryProp.codec.encode(entry.snapshots.map(storedSnapshot));
	}
	if (entry.archived) out[srsArchivedProp.name] = true;
	return out;
};
var emptyRoamMemoSummary = () => ({
	entries: 0,
	matchedTargets: 0,
	activeTargets: 0,
	archivedTargets: 0,
	toReviewRefs: 0,
	snapshots: 0,
	targetsWithHistory: 0,
	missingTargets: 0,
	unsupportedSessions: 0
});
var collectRoamMemoEntries = (pages, knownUids, workspaceId) => {
	const byTargetUid = /* @__PURE__ */ new Map();
	const summary = emptyRoamMemoSummary();
	const dataBlock = pages.find((page) => page.title === "roam/memo")?.children?.find((child) => child.string === "data");
	if (!dataBlock?.children) return {
		byTargetUid,
		summary
	};
	for (const entryBlock of dataBlock.children) {
		summary.entries += 1;
		const targetRoamUid = blockRefUidFromContent(entryBlock.string);
		const children = entryBlock.children ?? [];
		const archived = children.some((child) => pageRefAliasFromContent(child.string) === "memo/archived");
		const toReview = children.some((child) => pageRefAliasFromContent(child.string) === "memo/to-review");
		if (toReview) summary.toReviewRefs += 1;
		const snapshots = [];
		for (const child of children) {
			if (!/^\s*\[\[/.test(child.string ?? "") || !child.children?.length) continue;
			const session = parseRoamMemoSession(child, workspaceId);
			if (session) snapshots.push(session);
			else summary.unsupportedSessions += 1;
		}
		if (!targetRoamUid || !knownUids.has(targetRoamUid)) {
			summary.missingTargets += 1;
			continue;
		}
		snapshots.sort((a, b) => a.reviewedAtIso.localeCompare(b.reviewedAtIso));
		const existing = byTargetUid.get(targetRoamUid);
		const mergedSnapshots = existing ? [...existing.snapshots, ...snapshots] : snapshots;
		mergedSnapshots.sort((a, b) => a.reviewedAtIso.localeCompare(b.reviewedAtIso));
		byTargetUid.set(targetRoamUid, {
			targetRoamUid,
			sourceRoamUid: entryBlock.uid,
			archived: (existing?.archived ?? false) || archived,
			toReview: (existing?.toReview ?? false) || toReview,
			snapshots: mergedSnapshots
		});
	}
	for (const entry of byTargetUid.values()) {
		summary.matchedTargets += 1;
		summary.snapshots += entry.snapshots.length;
		if (entry.snapshots.length > 0 && !entry.archived) summary.activeTargets += 1;
		if (entry.archived) summary.archivedTargets += 1;
		if (entry.snapshots.length > 1) summary.targetsWithHistory += 1;
	}
	return {
		byTargetUid,
		summary
	};
};
var srsSourceConflictDiagnostics = (roamUid, schedule, memo) => {
	if (!schedule || !memo) return [];
	const latest = memo.snapshots.at(-1);
	if (!latest) return [];
	const conflicts = [];
	const check = (name, scheduleValue, memoValue) => {
		if (scheduleValue !== memoValue) conflicts.push(`${name} marker=${String(scheduleValue)} memo=${String(memoValue)}`);
	};
	check(srsIntervalProp.name, schedule.interval, latest.interval);
	check(srsFactorProp.name, schedule.factor, latest.factor);
	check(srsNextReviewDateProp.name, schedule.nextReviewDateId, latest.nextReviewDateId);
	check(srsReviewCountProp.name, schedule.reviewCount, latest.reviewCount);
	return conflicts.length === 0 ? [] : [`roam/memo SRS conflict on uid ${roamUid}: ${conflicts.join(", ")}`];
};
//#endregion
export { collectRoamMemoEntries, propertiesFromRoamMemo, srsSourceConflictDiagnostics };

//# sourceMappingURL=roamMemo.js.map