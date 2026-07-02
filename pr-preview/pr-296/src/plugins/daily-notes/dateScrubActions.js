import { Block } from "../../data/block.js";
import { ActionContextTypes } from "../../shortcuts/types.js";
import { applyKeyboardScrubDelta, endKeyboardScrub, startKeyboardScrubForTarget } from "./dateScrubGesture.js";
//#region src/plugins/daily-notes/dateScrubActions.ts
/**
* Keyboard-driven date scrub — wires the gesture's module-level scrub
* state machine into the action system.
*
* Trigger model: hold `s` in NORMAL_MODE for ~200ms to enter scrub
* mode. While `DATE_SCRUB_CONTEXT` is active (modal, shadows the
* underlying NORMAL_MODE/EDIT_MODE_CM bindings except `global`),
* arrows / h-j-k-l scrub by ±1 or ±7 days. Releasing `s` commits;
* Escape cancels.
*
* Why hold rather than a chord: avoids stealing common shortcuts and
* keeps the gesture self-contained — no Ctrl/Shift modifier-tracking,
* no bare-modifier activation. The cost is dropping keyboard scrub from
* EDIT_MODE_CM (typing `s` is real input there); trackpad Ctrl+Shift+
* wheel still works in CodeMirror via the gesture module's window
* listener.
*
* Coordination with the scrub state machine in `dateScrubGesture.ts`:
*   - `startKeyboardScrubForTarget` asks the registered overlay handler
*     to accept; we only activate the context if it does.
*   - `applyKeyboardScrubDelta` mutates the running keyboardScrub state
*     each movement key press; the overlay re-renders via its `update`
*     callback.
*   - `endKeyboardScrub(commit)` finalises the scrub. Idempotent so
*     either the action or the wheel-path keyup listener can call it.
*/
var DATE_SCRUB_CONTEXT = "date-scrub";
var ENTER_DATE_SCRUB_ACTION_ID = "date-scrub.enter";
var DATE_SCRUB_COMMIT_ACTION_ID = "date-scrub.commit";
var DATE_SCRUB_CANCEL_ACTION_ID = "date-scrub.cancel";
var DATE_SCRUB_DAY_FORWARD_ACTION_ID = "date-scrub.day-forward";
var DATE_SCRUB_DAY_BACKWARD_ACTION_ID = "date-scrub.day-backward";
var DATE_SCRUB_WEEK_FORWARD_ACTION_ID = "date-scrub.week-forward";
var DATE_SCRUB_WEEK_BACKWARD_ACTION_ID = "date-scrub.week-backward";
/** Long enough that a quick `s` tap doesn't trigger scrub on blocks the
*  user just wanted to focus, short enough to feel immediate when
*  intentionally holding. 200ms (the Apple long-press standard) felt
*  sluggish in practice; 100ms is comfortably under the perception
*  threshold while still distinguishable from a tap. */
var HOLD_THRESHOLD_MS = 100;
var isDateScrubDependencies = (deps) => typeof deps === "object" && deps !== null && "uiStateBlock" in deps && deps.uiStateBlock instanceof Block;
var dateScrubActionContext = {
	type: DATE_SCRUB_CONTEXT,
	displayName: "Date Scrub",
	modal: true,
	validateDependencies: isDateScrubDependencies
};
var enterDateScrubAction = {
	id: ENTER_DATE_SCRUB_ACTION_ID,
	description: "Enter date scrub mode (hold)",
	context: ActionContextTypes.NORMAL_MODE,
	defaultBinding: {
		keys: "s",
		phase: "hold",
		holdMs: HOLD_THRESHOLD_MS
	},
	handler: ({ block, uiStateBlock }, _trigger, dispatch) => {
		if (!startKeyboardScrubForTarget({ block })) return;
		const dependencies = {
			block,
			uiStateBlock
		};
		dispatch?.activate(DATE_SCRUB_CONTEXT, dependencies);
	}
};
var dateScrubCommitAction = {
	id: DATE_SCRUB_COMMIT_ACTION_ID,
	description: "Commit date scrub",
	context: DATE_SCRUB_CONTEXT,
	defaultBinding: {
		keys: "s",
		phase: "keyup"
	},
	handler: (_deps, _trigger, dispatch) => {
		endKeyboardScrub(true);
		dispatch?.deactivate(DATE_SCRUB_CONTEXT);
	}
};
var dateScrubCancelAction = {
	id: DATE_SCRUB_CANCEL_ACTION_ID,
	description: "Cancel date scrub",
	context: DATE_SCRUB_CONTEXT,
	defaultBinding: { keys: "Escape" },
	handler: (_deps, _trigger, dispatch) => {
		endKeyboardScrub(false);
		dispatch?.deactivate(DATE_SCRUB_CONTEXT);
	}
};
var dateScrubMovementAction = (id, description, keys, deltaDays) => ({
	id,
	description,
	context: DATE_SCRUB_CONTEXT,
	defaultBinding: { keys: [...keys] },
	handler: () => {
		applyKeyboardScrubDelta(deltaDays);
	}
});
var dateScrubActions = [
	enterDateScrubAction,
	dateScrubCommitAction,
	dateScrubCancelAction,
	dateScrubMovementAction(DATE_SCRUB_DAY_FORWARD_ACTION_ID, "Date scrub: forward one day", ["ArrowUp", "k"], 1),
	dateScrubMovementAction(DATE_SCRUB_DAY_BACKWARD_ACTION_ID, "Date scrub: backward one day", ["ArrowDown", "j"], -1),
	dateScrubMovementAction(DATE_SCRUB_WEEK_FORWARD_ACTION_ID, "Date scrub: forward one week", ["ArrowRight", "l"], 7),
	dateScrubMovementAction(DATE_SCRUB_WEEK_BACKWARD_ACTION_ID, "Date scrub: backward one week", ["ArrowLeft", "h"], -7)
];
//#endregion
export { DATE_SCRUB_CANCEL_ACTION_ID, DATE_SCRUB_COMMIT_ACTION_ID, DATE_SCRUB_CONTEXT, DATE_SCRUB_DAY_BACKWARD_ACTION_ID, DATE_SCRUB_DAY_FORWARD_ACTION_ID, DATE_SCRUB_WEEK_BACKWARD_ACTION_ID, DATE_SCRUB_WEEK_FORWARD_ACTION_ID, ENTER_DATE_SCRUB_ACTION_ID, dateScrubActionContext, dateScrubActions };

//# sourceMappingURL=dateScrubActions.js.map