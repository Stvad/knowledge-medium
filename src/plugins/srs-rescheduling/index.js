import { ChangeScope } from "../../data/api/changeScope.js";
import "../../data/api/index.js";
import { getBlockTypes } from "../../data/properties.js";
import { systemToggle } from "../../facets/togglable.js";
import { actionTransformsFacet, actionsFacet } from "../../extensions/core.js";
import { formatIsoDate } from "../../utils/dailyPage.js";
import { dailyNoteBlockId, getOrCreateDailyNote } from "../daily-notes/dailyNotes.js";
import { showCustom } from "../../utils/toast.js";
import { SRS_SM25_TYPE, srsArchivedProp, srsFactorProp, srsGradeProp, srsIntervalProp, srsNextReviewDateProp, srsReviewCountProp, srsSm25Type, srsSnapshotHistoryProp } from "./schema.js";
import { srsReschedulingDataExtension } from "./dataExtension.js";
import { Check } from "../../../node_modules/lucide-react/dist/esm/icons/check.js";
import { ClipboardPaste } from "../../../node_modules/lucide-react/dist/esm/icons/clipboard-paste.js";
import { ClockArrowDown } from "../../../node_modules/lucide-react/dist/esm/icons/clock-arrow-down.js";
import { Gauge } from "../../../node_modules/lucide-react/dist/esm/icons/gauge.js";
import { RotateCcw } from "../../../node_modules/lucide-react/dist/esm/icons/rotate-ccw.js";
import { Scissors } from "../../../node_modules/lucide-react/dist/esm/icons/scissors.js";
import { Sparkles } from "../../../node_modules/lucide-react/dist/esm/icons/sparkles.js";
import { ActionContextTypes } from "../../shortcuts/types.js";
import { blockContentSurfacePropsFacet } from "../../extensions/blockInteraction.js";
import { actionDispatchWrap } from "../../shortcuts/actionDispatch.js";
import { quickActionItemsFacet } from "../swipe-quick-actions/actions.js";
import "../swipe-quick-actions/index.js";
import { blockDateAdapterFacet } from "../daily-notes/blockDateAdapter.js";
import { getDateScrubDraft, stageDateScrubDraft } from "../daily-notes/dateScrubGesture.js";
import { DATE_SCRUB_CONTEXT } from "../daily-notes/dateScrubActions.js";
import "../daily-notes/index.js";
import { RescheduleToast } from "./RescheduleToast.js";
import { DEFAULT_FACTOR, SrsSignal, scheduleSrsProperties, srsSignals } from "./scheduler.js";
import { srsBarClass, srsIndicatorTitle } from "./indicator.js";
import { moveSrsState } from "./moveSrsState.js";
import { clearSrsClipboard, getSrsClipboard, setSrsClipboard } from "./srsClipboard.js";
import { srsBlockDateAdapter } from "./srsBlockDateAdapter.js";
import { srsRescheduleDecorator } from "./rescheduleDecorator.js";
import { srsSwipeRightDecorator, srsTodoCycleDecorators } from "./swipeRightDecorator.js";
import { createElement } from "react";
//#region src/plugins/srs-rescheduling/index.ts
var shortcutKeysForSignal = (signal) => {
	const key = String(signal);
	return [`Control+Shift+Digit${key}`, `Control+Shift+Alt+Meta+Digit${key}`];
};
var signalName = (signal) => SrsSignal[signal];
var gradeForSignal = (signal) => {
	switch (signal) {
		case SrsSignal.AGAIN: return 0;
		case SrsSignal.HARD: return 2;
		case SrsSignal.GOOD: return 4;
		case SrsSignal.EASY: return 5;
		case SrsSignal.SOONER: return 3;
	}
};
var iconForSignal = (signal) => {
	switch (signal) {
		case SrsSignal.AGAIN: return RotateCcw;
		case SrsSignal.HARD: return Gauge;
		case SrsSignal.GOOD: return Check;
		case SrsSignal.EASY: return Sparkles;
		case SrsSignal.SOONER: return ClockArrowDown;
	}
};
var readProperty = (properties, schema, fallback) => {
	const stored = properties[schema.name];
	if (stored === void 0) return fallback;
	try {
		return schema.codec.decode(stored);
	} catch {
		return fallback;
	}
};
var isSrsScrubDraftPayload = (payload) => typeof payload === "object" && payload !== null && payload.plugin === "srs-rescheduling";
var isDateScrubDateDraftPayload = (payload) => typeof payload === "object" && payload !== null && payload.plugin === "daily-notes.date-scrub";
var scheduleFromIsoForDraft = (draft) => {
	if (!draft) return void 0;
	if (isDateScrubDateDraftPayload(draft.payload) && draft.payload.deltaDays === 0) return;
	return draft.currentIso;
};
var dateFromIso = (iso) => {
	const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso);
	if (!match) return null;
	return new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
};
var snapshotForPlan = (plan) => ({
	reviewedAt: dailyNoteBlockId(plan.workspaceId, plan.reviewedIso),
	grade: plan.grade,
	interval: plan.newInterval,
	factor: plan.newFactor,
	reviewCount: plan.nextReviewCount
});
var basisFromPlan = (plan) => ({
	workspaceId: plan.workspaceId,
	interval: plan.newInterval,
	factor: plan.newFactor,
	reviewCount: plan.nextReviewCount,
	history: [...plan.history, snapshotForPlan(plan)],
	scheduleFrom: dateFromIso(plan.nextReviewIso) ?? plan.nextReviewDate,
	reviewedIso: plan.reviewedIso
});
var basisFromBlock = async (block, scheduleFromIso) => {
	if (block.repo.isReadOnly) return null;
	const data = block.peek() ?? await block.load();
	if (!data) return null;
	const sourceProperties = getBlockTypes(data).includes("srs-sm2.5") ? data.properties : {};
	const now = /* @__PURE__ */ new Date();
	return {
		workspaceId: data.workspaceId,
		interval: readProperty(sourceProperties, srsIntervalProp, 2),
		factor: readProperty(sourceProperties, srsFactorProp, DEFAULT_FACTOR),
		reviewCount: readProperty(sourceProperties, srsReviewCountProp, 0),
		history: readProperty(sourceProperties, srsSnapshotHistoryProp, []),
		scheduleFrom: scheduleFromIso ? dateFromIso(scheduleFromIso) ?? now : now,
		reviewedIso: formatIsoDate(now)
	};
};
var planSrsRescheduleFromBasis = (basis, signal) => {
	const grade = gradeForSignal(signal);
	const scheduled = scheduleSrsProperties({
		interval: basis.interval,
		factor: basis.factor
	}, signal, { now: basis.scheduleFrom });
	const nextReviewCount = basis.reviewCount + 1;
	return {
		signal,
		workspaceId: basis.workspaceId,
		previousInterval: basis.interval,
		newInterval: scheduled.interval,
		newFactor: scheduled.factor,
		nextReviewDate: scheduled.nextReviewDate,
		previousReviewCount: basis.reviewCount,
		grade,
		nextReviewIso: formatIsoDate(scheduled.nextReviewDate),
		reviewedIso: basis.reviewedIso,
		nextReviewCount,
		history: basis.history
	};
};
var planSrsReschedule = async (block, signal, options = {}) => {
	const basis = await basisFromBlock(block, options.scheduleFromIso);
	return basis ? planSrsRescheduleFromBasis(basis, signal) : null;
};
var applySrsReschedulePlan = async (block, plan) => {
	if (block.repo.isReadOnly) return false;
	return block.repo.undoGroup(async (repo) => {
		const nextReviewDaily = await getOrCreateDailyNote(repo, plan.workspaceId, plan.nextReviewIso);
		const reviewedDaily = await getOrCreateDailyNote(repo, plan.workspaceId, plan.reviewedIso);
		const snapshot = {
			...snapshotForPlan(plan),
			reviewedAt: reviewedDaily.id
		};
		const typeSnapshot = repo.snapshotTypeRegistries();
		let written = false;
		await repo.tx(async (tx) => {
			let row = await tx.get(block.id);
			if (!row) return;
			if (!getBlockTypes(row).includes("srs-sm2.5")) {
				await repo.addTypeInTx(tx, block.id, SRS_SM25_TYPE, {}, typeSnapshot);
				row = await tx.get(block.id);
				if (!row) return;
			}
			await tx.update(block.id, { properties: {
				...row.properties,
				[srsIntervalProp.name]: srsIntervalProp.codec.encode(plan.newInterval),
				[srsFactorProp.name]: srsFactorProp.codec.encode(plan.newFactor),
				[srsNextReviewDateProp.name]: srsNextReviewDateProp.codec.encode(nextReviewDaily.id),
				[srsReviewCountProp.name]: srsReviewCountProp.codec.encode(plan.nextReviewCount),
				[srsGradeProp.name]: srsGradeProp.codec.encode(plan.grade),
				[srsSnapshotHistoryProp.name]: srsSnapshotHistoryProp.codec.encode([...plan.history, snapshot])
			} });
			written = true;
		}, {
			scope: ChangeScope.BlockDefault,
			description: "srs reschedule"
		});
		return written;
	});
};
var rescheduleBlock = async (block, signal) => {
	const plan = await planSrsReschedule(block, signal);
	if (!plan) return null;
	return await applySrsReschedulePlan(block, plan) ? plan : null;
};
var formatIntervalDays = (days) => {
	const ceil = Math.max(1, Math.ceil(days));
	if (ceil < 30) return `${ceil}d`;
	if (ceil < 365) return `${Math.round(ceil / 30)}mo`;
	return `${Math.round(ceil / 365)}y`;
};
var formatShortDate = (date) => date.toLocaleString("en-US", {
	month: "short",
	day: "numeric"
});
var formatRescheduleToastMessage = (result) => {
	const name = signalName(result.signal);
	const next = formatIntervalDays(result.newInterval);
	const when = formatShortDate(result.nextReviewDate);
	if (result.previousReviewCount > 0) return `${name} · ${formatIntervalDays(result.previousInterval)} → ${next} (${when})`;
	return `${name} · ${next} (${when})`;
};
var formatRescheduleScrubDetail = (result) => {
	const next = formatIntervalDays(result.newInterval);
	if (result.previousReviewCount === 0) return next;
	return `${formatIntervalDays(result.previousInterval)} -> ${next}`;
};
var formatRescheduleScrubPreview = (result) => ({
	label: `SRS ${signalName(result.signal)}`,
	value: formatShortDate(result.nextReviewDate),
	detail: formatRescheduleScrubDetail(result)
});
var shiftPlanDate = (plan, deltaDays) => {
	const nextReviewDate = new Date(plan.nextReviewDate);
	nextReviewDate.setDate(nextReviewDate.getDate() + deltaDays);
	return {
		...plan,
		nextReviewDate,
		nextReviewIso: formatIsoDate(nextReviewDate)
	};
};
var createSrsScrubDraft = (block, plan) => ({
	id: `date-scrub.srs.reschedule.${signalName(plan.signal).toLowerCase()}`,
	currentIso: plan.nextReviewIso,
	preview: formatRescheduleScrubPreview(plan),
	payload: {
		plugin: "srs-rescheduling",
		plan
	},
	shiftDate: (deltaDays) => createSrsScrubDraft(block, shiftPlanDate(plan, deltaDays)),
	commit: async () => {
		await applySrsReschedulePlan(block, plan);
	}
});
var runRescheduleWithFeedback = async (block, signal) => {
	const result = await rescheduleBlock(block, signal);
	if (!result) return;
	const workspaceId = block.peek()?.workspaceId;
	if (!workspaceId) return;
	const groupId = block.repo.undoManagerFor(workspaceId).peekUndo(ChangeScope.BlockDefault)?.groupId;
	if (!groupId) return;
	const message = formatRescheduleToastMessage(result);
	showCustom((id) => createElement(RescheduleToast, {
		toastId: id,
		message,
		groupId,
		workspaceId,
		repo: block.repo
	}));
};
var createRescheduleAction = (signal, { context, idPrefix = "", descriptionSuffix = "" }) => {
	const name = signalName(signal);
	return {
		id: `${idPrefix}srs.reschedule.${name.toLowerCase()}`,
		description: `SRS: ${name}${descriptionSuffix}`,
		context,
		icon: iconForSignal(signal),
		handler: (async ({ block }) => {
			await runRescheduleWithFeedback(block, signal);
		}),
		defaultBinding: {
			keys: shortcutKeysForSignal(signal),
			eventOptions: { preventDefault: true }
		}
	};
};
var blockFromDependencies = (deps) => {
	const block = deps.block;
	return block && typeof block.id === "string" ? block : null;
};
var createScrubRescheduleAction = (signal) => {
	const name = signalName(signal);
	return {
		id: `date-scrub.srs.reschedule.${name.toLowerCase()}`,
		description: `SRS: ${name} (Date Scrub)`,
		context: DATE_SCRUB_CONTEXT,
		icon: iconForSignal(signal),
		isVisible: (deps) => {
			const data = blockFromDependencies(deps)?.peek();
			return !!data && getBlockTypes(data).includes("srs-sm2.5");
		},
		handler: async (deps) => {
			const block = blockFromDependencies(deps);
			if (!block) return;
			const currentDraft = getDateScrubDraft(block.id);
			const currentPayload = currentDraft?.payload;
			const plan = isSrsScrubDraftPayload(currentPayload) ? planSrsRescheduleFromBasis(basisFromPlan(currentPayload.plan), signal) : await planSrsReschedule(block, signal, { scheduleFromIso: scheduleFromIsoForDraft(currentDraft) });
			if (!plan) return;
			stageDateScrubDraft(block.id, createSrsScrubDraft(block, plan));
		},
		defaultBinding: {
			keys: `Digit${signal}`,
			eventOptions: { preventDefault: true }
		}
	};
};
var isSrsBlockTarget = ({ block }) => {
	const data = block.peek();
	return !!data && getBlockTypes(data).includes("srs-sm2.5");
};
var canPasteSrsState = ({ block }) => {
	const entry = getSrsClipboard();
	if (entry === null || entry.sourceBlockId === block.id) return false;
	return entry.sourceWorkspaceId === block.peek()?.workspaceId;
};
var srsCutAction = {
	id: "srs.cut",
	description: "SRS: Cut state",
	context: ActionContextTypes.NORMAL_MODE,
	icon: Scissors,
	isVisible: isSrsBlockTarget,
	canDispatch: isSrsBlockTarget,
	handler: async ({ block }) => {
		const data = block.peek() ?? await block.load();
		if (!data) return;
		setSrsClipboard({
			sourceBlockId: block.id,
			sourceWorkspaceId: data.workspaceId
		});
	}
};
var srsPasteAction = {
	id: "srs.paste",
	description: "SRS: Paste state",
	context: ActionContextTypes.NORMAL_MODE,
	icon: ClipboardPaste,
	isVisible: canPasteSrsState,
	canDispatch: canPasteSrsState,
	handler: async ({ block }) => {
		const entry = getSrsClipboard();
		if (!entry) return;
		if (entry.sourceBlockId === block.id) return;
		await moveSrsState(block.repo, entry.sourceBlockId, block.id);
		clearSrsClipboard();
	}
};
var srsReschedulingActions = [
	...srsSignals.map((signal) => createRescheduleAction(signal, { context: ActionContextTypes.NORMAL_MODE })),
	...srsSignals.map((signal) => createRescheduleAction(signal, {
		context: ActionContextTypes.EDIT_MODE_CM,
		idPrefix: "edit.cm.",
		descriptionSuffix: " (Edit Mode)"
	})),
	...srsSignals.map((signal) => createScrubRescheduleAction(signal)),
	srsCutAction,
	srsPasteAction
];
var srsQuickActionItems = srsSignals.filter((signal) => signal !== SrsSignal.SOONER).map((signal) => ({
	actionId: `srs.reschedule.${signalName(signal).toLowerCase()}`,
	label: signalName(signal),
	row: 2
}));
var srsCutQuickAction = {
	actionId: "srs.cut",
	label: "Cut SRS",
	overflow: true
};
var srsPasteQuickAction = {
	actionId: "srs.paste",
	label: "Paste SRS",
	overflow: true
};
var srsContentSurfaceDecoration = ({ block }) => {
	const data = block.peek();
	if (!data || !getBlockTypes(data).includes("srs-sm2.5")) return null;
	const indicatorState = {
		interval: readProperty(data.properties, srsIntervalProp, 2),
		factor: readProperty(data.properties, srsFactorProp, DEFAULT_FACTOR),
		reviewCount: readProperty(data.properties, srsReviewCountProp, 0),
		archived: readProperty(data.properties, srsArchivedProp, false)
	};
	return {
		className: srsBarClass(indicatorState),
		title: srsIndicatorTitle(indicatorState)
	};
};
var srsReschedulingPlugin = systemToggle({
	id: "system:srs-rescheduling",
	name: "SRS rescheduling",
	description: "Spaced-repetition scheduling for blocks with a next-review date."
}).of([
	srsReschedulingDataExtension,
	srsQuickActionItems.map((item) => quickActionItemsFacet.of(item, { source: "srs-rescheduling" })),
	quickActionItemsFacet.of(srsCutQuickAction, { source: "srs-rescheduling" }),
	quickActionItemsFacet.of(srsPasteQuickAction, { source: "srs-rescheduling" }),
	blockContentSurfacePropsFacet.of(srsContentSurfaceDecoration, { source: "srs-rescheduling" }),
	srsReschedulingActions.map((action) => actionsFacet.of(action, { source: "srs-rescheduling" })),
	actionTransformsFacet.of(srsRescheduleDecorator, { source: "srs-rescheduling" }),
	actionDispatchWrap(srsSwipeRightDecorator, { source: "srs-rescheduling" }),
	srsTodoCycleDecorators.map((decorator) => actionDispatchWrap(decorator, { source: "srs-rescheduling" })),
	blockDateAdapterFacet.of(srsBlockDateAdapter, {
		source: "srs-rescheduling",
		precedence: -1
	})
]);
//#endregion
export { SRS_SM25_TYPE, applySrsReschedulePlan, formatIntervalDays, formatRescheduleToastMessage, planSrsReschedule, rescheduleBlock, srsArchivedProp, srsBlockDateAdapter, srsFactorProp, srsGradeProp, srsIntervalProp, srsNextReviewDateProp, srsReschedulingActions, srsReschedulingDataExtension, srsReschedulingPlugin, srsReviewCountProp, srsSm25Type, srsSnapshotHistoryProp };

//# sourceMappingURL=index.js.map