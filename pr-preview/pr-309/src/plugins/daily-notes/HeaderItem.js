import { useRepo } from "../../context/repo.js";
import { CalendarDays } from "../../../node_modules/lucide-react/dist/esm/icons/calendar-days.js";
import { ChevronRight } from "../../../node_modules/lucide-react/dist/esm/icons/chevron-right.js";
import { ChevronLeft } from "../../../node_modules/lucide-react/dist/esm/icons/chevron-left.js";
import { useRunAction } from "../../shortcuts/runAction.js";
import { openDialog } from "../../utils/dialogs.js";
import { OPEN_NEXT_DAILY_NOTE_ACTION_ID, OPEN_PREVIOUS_DAILY_NOTE_ACTION_ID, resolveCurrentDailyNoteIso } from "./actions.js";
import { DailyNotePicker } from "./DailyNotePicker.js";
import { c } from "react/compiler-runtime";
import { jsx, jsxs } from "react/jsx-runtime";
//#region src/plugins/daily-notes/HeaderItem.tsx
var runHeaderActionEvent = (actionId) => new CustomEvent("daily-note-header-action", { detail: { actionId } });
function DailyNotePickerHeaderItem() {
	const $ = c(23);
	const repo = useRepo();
	const runAction = useRunAction();
	let t0;
	if ($[0] !== repo) {
		t0 = async (event) => {
			const { bottom, height, left, right, top, width } = event.currentTarget.getBoundingClientRect();
			const workspaceId = repo.activeWorkspaceId;
			const initialIso = workspaceId ? await resolveCurrentDailyNoteIso(repo, workspaceId) ?? void 0 : void 0;
			openDialog(DailyNotePicker, {
				anchorRect: {
					bottom,
					height,
					left,
					right,
					top,
					width
				},
				initialIso
			});
		};
		$[0] = repo;
		$[1] = t0;
	} else t0 = $[1];
	const handleClick = t0;
	let t1;
	if ($[2] !== runAction) {
		t1 = (actionId) => {
			try {
				Promise.resolve(runAction(actionId, runHeaderActionEvent(actionId))).catch((error_0) => {
					console.error(`[DailyNotePickerHeaderItem] Action ${actionId} rejected`, error_0);
				});
			} catch (t2) {
				const error = t2;
				console.error(`[DailyNotePickerHeaderItem] Action ${actionId} threw`, error);
			}
		};
		$[2] = runAction;
		$[3] = t1;
	} else t1 = $[3];
	const runDailyNoteAction = t1;
	let t2;
	if ($[4] !== runDailyNoteAction) {
		t2 = () => runDailyNoteAction(OPEN_PREVIOUS_DAILY_NOTE_ACTION_ID);
		$[4] = runDailyNoteAction;
		$[5] = t2;
	} else t2 = $[5];
	let t3;
	if ($[6] === Symbol.for("react.memo_cache_sentinel")) {
		t3 = /* @__PURE__ */ jsx(ChevronLeft, { className: "h-5 w-5" });
		$[6] = t3;
	} else t3 = $[6];
	let t4;
	if ($[7] !== t2) {
		t4 = /* @__PURE__ */ jsx("button", {
			className: "inline-flex h-7 w-7 items-center justify-center rounded-md transition-colors hover:text-foreground sm:h-8 sm:w-8",
			onClick: t2,
			title: "Open previous daily note",
			"aria-label": "Open previous daily note",
			children: t3
		});
		$[7] = t2;
		$[8] = t4;
	} else t4 = $[8];
	let t5;
	if ($[9] !== handleClick) {
		t5 = (event_0) => {
			handleClick(event_0).catch(_temp);
		};
		$[9] = handleClick;
		$[10] = t5;
	} else t5 = $[10];
	let t6;
	if ($[11] === Symbol.for("react.memo_cache_sentinel")) {
		t6 = /* @__PURE__ */ jsx(CalendarDays, { className: "h-5 w-5" });
		$[11] = t6;
	} else t6 = $[11];
	let t7;
	if ($[12] !== t5) {
		t7 = /* @__PURE__ */ jsx("button", {
			className: "inline-flex h-7 w-7 items-center justify-center rounded-md transition-colors hover:text-foreground sm:h-8 sm:w-8",
			onClick: t5,
			title: "Open daily note picker",
			"aria-label": "Open daily note picker",
			children: t6
		});
		$[12] = t5;
		$[13] = t7;
	} else t7 = $[13];
	let t8;
	if ($[14] !== runDailyNoteAction) {
		t8 = () => runDailyNoteAction(OPEN_NEXT_DAILY_NOTE_ACTION_ID);
		$[14] = runDailyNoteAction;
		$[15] = t8;
	} else t8 = $[15];
	let t9;
	if ($[16] === Symbol.for("react.memo_cache_sentinel")) {
		t9 = /* @__PURE__ */ jsx(ChevronRight, { className: "h-5 w-5" });
		$[16] = t9;
	} else t9 = $[16];
	let t10;
	if ($[17] !== t8) {
		t10 = /* @__PURE__ */ jsx("button", {
			className: "inline-flex h-7 w-7 items-center justify-center rounded-md transition-colors hover:text-foreground sm:h-8 sm:w-8",
			onClick: t8,
			title: "Open next daily note",
			"aria-label": "Open next daily note",
			children: t9
		});
		$[17] = t8;
		$[18] = t10;
	} else t10 = $[18];
	let t11;
	if ($[19] !== t10 || $[20] !== t4 || $[21] !== t7) {
		t11 = /* @__PURE__ */ jsxs("div", {
			className: "inline-flex h-7 items-center gap-0.5 text-muted-foreground sm:h-8",
			children: [
				t4,
				t7,
				t10
			]
		});
		$[19] = t10;
		$[20] = t4;
		$[21] = t7;
		$[22] = t11;
	} else t11 = $[22];
	return t11;
}
function _temp(error_1) {
	console.error("[DailyNotePickerHeaderItem] Open picker failed", error_1);
}
//#endregion
export { DailyNotePickerHeaderItem };

//# sourceMappingURL=HeaderItem.js.map