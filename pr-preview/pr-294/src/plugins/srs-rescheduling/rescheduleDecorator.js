import { RESCHEDULE_BLOCK_DATE_ACTION_ID } from "../daily-notes/rescheduleAction.js";
import { srsBlockDateAdapter } from "./srsBlockDateAdapter.js";
//#region src/plugins/srs-rescheduling/rescheduleDecorator.ts
/**
* Extends the daily-notes "Reschedule" action so it stays visible on
* SRS blocks that don't have an inline date reference (where the base
* `isVisible` would say "nope, no shiftable date here"). The handler is
* shared — it only opens the picker, and the picker resolves the right
* adapter at commit time via `blockDateAdapterFacet`.
*/
var srsRescheduleDecorator = {
	actionId: RESCHEDULE_BLOCK_DATE_ACTION_ID,
	apply: (action) => ({
		...action,
		isVisible: (deps) => {
			const block = deps.block;
			if (block && srsBlockDateAdapter.canHandle(block)) return true;
			return action.isVisible?.(deps) ?? true;
		}
	})
};
//#endregion
export { srsRescheduleDecorator };

//# sourceMappingURL=rescheduleDecorator.js.map