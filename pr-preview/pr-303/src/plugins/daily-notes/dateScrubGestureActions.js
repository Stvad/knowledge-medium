import { ActionContextTypes } from "../../shortcuts/types.js";
import "../../shortcuts/gestureAction.js";
import { DATE_SCRUB_COMMIT_GESTURE, DATE_SCRUB_GESTURE, endTouchScrub, startTouchScrub, updateTouchScrub } from "./dateScrubGesture.js";
//#region src/plugins/daily-notes/dateScrubGestureActions.ts
/**
* `date-scrub` PROGRESS: drive the overlay's live preview. The first (begin)
* tick opens the overlay at the locked midpoint, every tick streams the day
* delta, and the synthesized settle on a non-committing release / pointercancel
* reverts it.
*/
var dateScrubRevealAction = {
	id: "daily-notes.date-scrub.reveal",
	description: "Two-finger date scrub: live date preview",
	context: ActionContextTypes.BLOCK_POINTER,
	gestureBinding: {
		gesture: DATE_SCRUB_GESTURE,
		phase: "progress"
	},
	handler: ({ block }, trigger) => {
		if (trigger.type === "gesture-progress-cancel") {
			endTouchScrub(false);
			return;
		}
		const { deltaDays, cancelIntent, begin } = trigger.detail;
		if (begin) startTouchScrub({
			block,
			blockId: block.id,
			startX: begin.startX,
			startY: begin.startY
		});
		updateTouchScrub(deltaDays, cancelIntent);
	}
};
/** `date-scrub-commit` COMMIT: write the previewed date. */
var dateScrubCommitAction = {
	id: "daily-notes.date-scrub.commit",
	description: "Two-finger date scrub: commit the new date",
	context: ActionContextTypes.BLOCK_POINTER,
	gestureBinding: { gesture: DATE_SCRUB_COMMIT_GESTURE },
	handler: () => {
		endTouchScrub(true);
	}
};
var dateScrubGestureActions = [dateScrubRevealAction, dateScrubCommitAction];
//#endregion
export { dateScrubCommitAction, dateScrubGestureActions, dateScrubRevealAction };

//# sourceMappingURL=dateScrubGestureActions.js.map