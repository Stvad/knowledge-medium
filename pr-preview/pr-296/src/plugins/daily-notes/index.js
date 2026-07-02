import { systemToggle } from "../../facets/togglable.js";
import { actionContextsFacet, actionsFacet, appMountsFacet, headerItemsFacet, workspaceLandingFacet } from "../../extensions/core.js";
import { DAILY_NOTE_TYPE, dailyNoteDateProp, dailyNoteType } from "./schema.js";
import { DAILY_NOTE_NS, JOURNAL_NS, addDaysIso, dailyNoteBlockId, dailyNoteCreatedAt, ensureDailyNoteTarget, getOrCreateDailyNote, getOrCreateJournalBlock, isDateAlias, isValidDateAlias, journalBlockId, todayIso } from "./dailyNotes.js";
import { dailyNotesDataExtension } from "./dataExtension.js";
import { CalendarDays } from "../../../node_modules/lucide-react/dist/esm/icons/calendar-days.js";
import { ActionContextTypes } from "../../shortcuts/types.js";
import { parseAppHash } from "../../utils/routing.js";
import { continuousGestureRecognizersFacet } from "../../extensions/continuousGestures.js";
import { openDialog } from "../../utils/dialogs.js";
import { dialogAppMountExtension } from "../../extensions/dialogAppMount.js";
import { quickActionItemsFacet } from "../swipe-quick-actions/actions.js";
import "../swipe-quick-actions/index.js";
import { APPEND_TODAY_DAILY_BLOCK_ACTION_ID, OPEN_NEXT_DAILY_NOTE_ACTION_ID, OPEN_PREVIOUS_DAILY_NOTE_ACTION_ID, OPEN_TODAY_ACTION_ID, appendTodayDailyBlockInStack, dailyNotesActions, resolveCurrentDailyNoteIso } from "./actions.js";
import { DailyNotePicker } from "./DailyNotePicker.js";
import { DailyNotePickerHeaderItem } from "./HeaderItem.js";
import { todayDailyNoteLanding } from "./landing.js";
import { blockDateAdapterFacet, hasAnyBlockDateAdapter, pickBlockDateAdapter } from "./blockDateAdapter.js";
import { referenceDateAdapter } from "./referenceDateAdapter.js";
import { wikilinkDisplayDecoratorFacet } from "../references/markdown/wikilinks/wikilinkDecorator.js";
import { ReschedulePicker } from "./ReschedulePicker.js";
import { dailyDateWikilinkDecorator } from "./wikilinkDateDecorator.js";
import { getDateScrubDraft, stageDateScrubDraft } from "./dateScrubGesture.js";
import { DateScrubOverlay } from "./DateScrubOverlay.js";
import { DateKeyboardScrubController } from "./DateKeyboardScrubController.js";
import { dateScrubRecognizer } from "./dateScrubRecognizer.js";
import { dateScrubGestureActions } from "./dateScrubGestureActions.js";
import { DATE_SCRUB_CANCEL_ACTION_ID, DATE_SCRUB_COMMIT_ACTION_ID, DATE_SCRUB_CONTEXT, DATE_SCRUB_DAY_BACKWARD_ACTION_ID, DATE_SCRUB_DAY_FORWARD_ACTION_ID, DATE_SCRUB_WEEK_BACKWARD_ACTION_ID, DATE_SCRUB_WEEK_FORWARD_ACTION_ID, ENTER_DATE_SCRUB_ACTION_ID, dateScrubActionContext, dateScrubActions } from "./dateScrubActions.js";
import { RESCHEDULE_BLOCK_DATE_ACTION_ID, rescheduleBlockDateAction, rescheduleQuickActionItem } from "./rescheduleAction.js";
import { randomUpcomingDateOffset, spreadBlockDates } from "./spreadBlockDates.js";
import { SPREAD_BLOCK_DATES_ACTION_ID, SPREAD_BLOCK_DATES_BLOCKS_ACTION_ID, spreadBlockDateAction, spreadBlockDatesAction, spreadBlockDatesGroupHeaderEntry } from "./spreadDatesAction.js";
import { groupedBacklinksGroupHeaderActionsFacet } from "../grouped-backlinks/facet.js";
//#region src/plugins/daily-notes/index.ts
var OPEN_DAILY_NOTE_PICKER_ACTION_ID = "open_daily_note_picker";
var dateScrubOverlayMount = {
	id: "daily-notes.date-scrub-overlay",
	component: DateScrubOverlay
};
var dateKeyboardScrubControllerMount = {
	id: "daily-notes.date-keyboard-scrub",
	component: DateKeyboardScrubController
};
var dailyNotePickerHeaderItem = {
	id: "daily-notes.date-picker-header",
	region: "start",
	component: DailyNotePickerHeaderItem
};
var openDailyNotePickerAction = ({ repo }) => ({
	id: OPEN_DAILY_NOTE_PICKER_ACTION_ID,
	description: "Open daily note picker",
	context: ActionContextTypes.GLOBAL,
	icon: CalendarDays,
	handler: async () => {
		const workspaceId = parseAppHash(window.location.hash).workspaceId ?? repo.activeWorkspaceId;
		openDialog(DailyNotePicker, { initialIso: workspaceId ? await resolveCurrentDailyNoteIso(repo, workspaceId) ?? void 0 : void 0 });
	}
});
var dailyNotesPlugin = ({ repo }) => systemToggle({
	id: "system:daily-notes",
	name: "Daily notes",
	description: "Date-keyed pages, the workspace-landing resolver that opens today on app open, and the prev/next/today shortcuts."
}).of([
	dailyNotesDataExtension,
	dialogAppMountExtension,
	appMountsFacet.of(dateScrubOverlayMount, { source: "daily-notes" }),
	appMountsFacet.of(dateKeyboardScrubControllerMount, { source: "daily-notes" }),
	dailyNotesActions({ repo }).map((action) => actionsFacet.of(action, { source: "daily-notes" })),
	actionsFacet.of(rescheduleBlockDateAction, { source: "daily-notes" }),
	quickActionItemsFacet.of(rescheduleQuickActionItem, { source: "daily-notes" }),
	actionsFacet.of(spreadBlockDateAction, { source: "daily-notes" }),
	actionsFacet.of(spreadBlockDatesAction, { source: "daily-notes" }),
	groupedBacklinksGroupHeaderActionsFacet.of(spreadBlockDatesGroupHeaderEntry, { source: "daily-notes" }),
	blockDateAdapterFacet.of(referenceDateAdapter, { source: "daily-notes" }),
	wikilinkDisplayDecoratorFacet.of(dailyDateWikilinkDecorator, { source: "daily-notes" }),
	continuousGestureRecognizersFacet.of(dateScrubRecognizer, { source: "daily-notes" }),
	dateScrubGestureActions.map((action) => actionsFacet.of(action, { source: "daily-notes" })),
	actionContextsFacet.of(dateScrubActionContext, { source: "daily-notes" }),
	dateScrubActions.map((action) => actionsFacet.of(action, { source: "daily-notes" })),
	actionsFacet.of(openDailyNotePickerAction({ repo }), { source: "daily-notes" }),
	headerItemsFacet.of(dailyNotePickerHeaderItem, {
		source: "daily-notes",
		precedence: 5
	}),
	workspaceLandingFacet.of(todayDailyNoteLanding, { source: "daily-notes" })
]);
//#endregion
export { APPEND_TODAY_DAILY_BLOCK_ACTION_ID, DAILY_NOTE_NS, DAILY_NOTE_TYPE, DATE_SCRUB_CANCEL_ACTION_ID, DATE_SCRUB_COMMIT_ACTION_ID, DATE_SCRUB_CONTEXT, DATE_SCRUB_DAY_BACKWARD_ACTION_ID, DATE_SCRUB_DAY_FORWARD_ACTION_ID, DATE_SCRUB_WEEK_BACKWARD_ACTION_ID, DATE_SCRUB_WEEK_FORWARD_ACTION_ID, DailyNotePicker, ENTER_DATE_SCRUB_ACTION_ID, JOURNAL_NS, OPEN_DAILY_NOTE_PICKER_ACTION_ID, OPEN_NEXT_DAILY_NOTE_ACTION_ID, OPEN_PREVIOUS_DAILY_NOTE_ACTION_ID, OPEN_TODAY_ACTION_ID, RESCHEDULE_BLOCK_DATE_ACTION_ID, ReschedulePicker, SPREAD_BLOCK_DATES_ACTION_ID, SPREAD_BLOCK_DATES_BLOCKS_ACTION_ID, addDaysIso, appendTodayDailyBlockInStack, blockDateAdapterFacet, dailyNoteBlockId, dailyNoteCreatedAt, dailyNoteDateProp, dailyNotePickerHeaderItem, dailyNoteType, dailyNotesDataExtension, dailyNotesPlugin, dateKeyboardScrubControllerMount, dateScrubActionContext, dateScrubActions, dateScrubOverlayMount, ensureDailyNoteTarget, getDateScrubDraft, getOrCreateDailyNote, getOrCreateJournalBlock, hasAnyBlockDateAdapter, isDateAlias, isValidDateAlias, journalBlockId, openDailyNotePickerAction, pickBlockDateAdapter, randomUpcomingDateOffset, referenceDateAdapter, rescheduleBlockDateAction, rescheduleQuickActionItem, resolveCurrentDailyNoteIso, spreadBlockDateAction, spreadBlockDates, spreadBlockDatesAction, spreadBlockDatesGroupHeaderEntry, stageDateScrubDraft, todayIso };

//# sourceMappingURL=index.js.map