import { CalendarRange } from "../../../node_modules/lucide-react/dist/esm/icons/calendar-range.js";
import { ActionContextTypes } from "../../shortcuts/types.js";
import { openDialog } from "../../utils/dialogs.js";
import { referenceDateAdapter } from "./referenceDateAdapter.js";
import { ReschedulePicker } from "./ReschedulePicker.js";
//#region src/plugins/daily-notes/rescheduleAction.ts
/**
* "Reschedule" quick-action — opens the calendar+strip sheet over the
* swiped block. The base action's `isVisible` gates on the regular
* date-reference adapter; the SRS plugin contributes a decorator that
* extends the gate to SRS blocks. The picker itself looks up the right
* adapter via `blockDateAdapterFacet` at commit time, so the handler
* doesn't need to know which kind of block it's acting on.
*/
var RESCHEDULE_BLOCK_DATE_ACTION_ID = "block.date.reschedule";
var rescheduleBlockDateAction = {
	id: RESCHEDULE_BLOCK_DATE_ACTION_ID,
	description: "Reschedule block date",
	context: ActionContextTypes.NORMAL_MODE,
	icon: CalendarRange,
	isVisible: ({ block }) => referenceDateAdapter.canHandle(block),
	handler: async ({ block }) => {
		if (!(block.peek() ?? await block.load())) return;
		openDialog(ReschedulePicker, { blockId: block.id });
	}
};
var rescheduleQuickActionItem = {
	actionId: RESCHEDULE_BLOCK_DATE_ACTION_ID,
	label: "Reschedule"
};
//#endregion
export { RESCHEDULE_BLOCK_DATE_ACTION_ID, rescheduleBlockDateAction, rescheduleQuickActionItem };

//# sourceMappingURL=rescheduleAction.js.map