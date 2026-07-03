import { cn } from "../../lib/utils.js";
import { todayIso } from "./dailyNotes.js";
import { ChevronRight } from "../../../node_modules/lucide-react/dist/esm/icons/chevron-right.js";
import { ChevronLeft } from "../../../node_modules/lucide-react/dist/esm/icons/chevron-left.js";
import { CALENDAR_WEEKDAY_LABELS, addMonths, buildCalendarCells, formatDayLabel, monthLabel } from "./calendar.js";
import { c } from "react/compiler-runtime";
import { Fragment, jsx, jsxs } from "react/jsx-runtime";
//#region src/plugins/daily-notes/CalendarGrid.tsx
var VARIANT_CLASSES = {
	destructive: {
		todayText: "font-semibold text-destructive",
		selectedBg: "bg-destructive text-destructive-foreground hover:bg-destructive hover:text-destructive-foreground"
	},
	primary: {
		todayText: "font-semibold text-primary",
		selectedBg: "bg-primary text-primary-foreground hover:bg-primary hover:text-primary-foreground"
	}
};
var CalendarGrid = (t0) => {
	const $ = c(49);
	const { visibleMonth, onVisibleMonthChange, selectedIso, onSelect, disabled: t1, variant: t2, cellClassName } = t0;
	const disabled = t1 === void 0 ? false : t1;
	const variant = t2 === void 0 ? "primary" : t2;
	let t3;
	if ($[0] === Symbol.for("react.memo_cache_sentinel")) {
		t3 = todayIso();
		$[0] = t3;
	} else t3 = $[0];
	const today = t3;
	let t4;
	if ($[1] !== visibleMonth) {
		t4 = buildCalendarCells(visibleMonth);
		$[1] = visibleMonth;
		$[2] = t4;
	} else t4 = $[2];
	const cells = t4;
	const tone = VARIANT_CLASSES[variant];
	let t5;
	if ($[3] !== onVisibleMonthChange || $[4] !== visibleMonth) {
		t5 = () => onVisibleMonthChange(addMonths(visibleMonth, -1));
		$[3] = onVisibleMonthChange;
		$[4] = visibleMonth;
		$[5] = t5;
	} else t5 = $[5];
	let t6;
	if ($[6] === Symbol.for("react.memo_cache_sentinel")) {
		t6 = /* @__PURE__ */ jsx(ChevronLeft, { className: "h-5 w-5" });
		$[6] = t6;
	} else t6 = $[6];
	let t7;
	if ($[7] !== t5) {
		t7 = /* @__PURE__ */ jsx("button", {
			type: "button",
			className: "inline-flex h-8 w-8 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-accent-foreground",
			"aria-label": "Previous month",
			onClick: t5,
			children: t6
		});
		$[7] = t5;
		$[8] = t7;
	} else t7 = $[8];
	let t8;
	if ($[9] !== visibleMonth) {
		t8 = monthLabel(visibleMonth);
		$[9] = visibleMonth;
		$[10] = t8;
	} else t8 = $[10];
	let t9;
	if ($[11] !== t8) {
		t9 = /* @__PURE__ */ jsx("span", { children: t8 });
		$[11] = t8;
		$[12] = t9;
	} else t9 = $[12];
	let t10;
	if ($[13] !== visibleMonth) {
		t10 = visibleMonth.getFullYear();
		$[13] = visibleMonth;
		$[14] = t10;
	} else t10 = $[14];
	let t11;
	if ($[15] !== t10) {
		t11 = /* @__PURE__ */ jsx("span", { children: t10 });
		$[15] = t10;
		$[16] = t11;
	} else t11 = $[16];
	let t12;
	if ($[17] !== t11 || $[18] !== t9) {
		t12 = /* @__PURE__ */ jsxs("div", {
			className: "flex min-w-0 items-baseline justify-center gap-2 text-lg font-semibold",
			children: [t9, t11]
		});
		$[17] = t11;
		$[18] = t9;
		$[19] = t12;
	} else t12 = $[19];
	let t13;
	if ($[20] !== onVisibleMonthChange || $[21] !== visibleMonth) {
		t13 = () => onVisibleMonthChange(addMonths(visibleMonth, 1));
		$[20] = onVisibleMonthChange;
		$[21] = visibleMonth;
		$[22] = t13;
	} else t13 = $[22];
	let t14;
	if ($[23] === Symbol.for("react.memo_cache_sentinel")) {
		t14 = /* @__PURE__ */ jsx(ChevronRight, { className: "h-5 w-5" });
		$[23] = t14;
	} else t14 = $[23];
	let t15;
	if ($[24] !== t13) {
		t15 = /* @__PURE__ */ jsx("button", {
			type: "button",
			className: "inline-flex h-8 w-8 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-accent-foreground",
			"aria-label": "Next month",
			onClick: t13,
			children: t14
		});
		$[24] = t13;
		$[25] = t15;
	} else t15 = $[25];
	let t16;
	if ($[26] !== t12 || $[27] !== t15 || $[28] !== t7) {
		t16 = /* @__PURE__ */ jsxs("div", {
			className: "mb-3 flex items-center justify-between gap-2",
			children: [
				t7,
				t12,
				t15
			]
		});
		$[26] = t12;
		$[27] = t15;
		$[28] = t7;
		$[29] = t16;
	} else t16 = $[29];
	let t17;
	if ($[30] === Symbol.for("react.memo_cache_sentinel")) {
		t17 = /* @__PURE__ */ jsx("div", {
			className: "mb-2 grid grid-cols-7 border-t pt-3 text-center text-sm font-semibold",
			children: CALENDAR_WEEKDAY_LABELS.map(_temp)
		});
		$[30] = t17;
	} else t17 = $[30];
	let t18;
	if ($[31] !== cellClassName || $[32] !== cells || $[33] !== disabled || $[34] !== onSelect || $[35] !== selectedIso || $[36] !== tone) {
		let t19;
		if ($[38] !== cellClassName || $[39] !== disabled || $[40] !== onSelect || $[41] !== selectedIso || $[42] !== tone) {
			t19 = (cell, index) => {
				if (!cell.date || !cell.iso) return /* @__PURE__ */ jsx("div", { className: cn("h-10", cellClassName) }, `empty-${index}`);
				const iso = cell.iso;
				const isToday = cell.iso === today;
				const isSelected = cell.iso === selectedIso;
				return /* @__PURE__ */ jsx("button", {
					type: "button",
					disabled,
					"aria-label": formatDayLabel(cell.date),
					"aria-current": isToday ? "date" : void 0,
					onClick: (event) => onSelect(iso, event),
					className: cn("inline-flex h-10 items-center justify-center rounded-sm text-base transition-colors hover:bg-accent hover:text-accent-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-60", isToday && tone.todayText, isSelected && tone.selectedBg, cellClassName),
					children: cell.date.getDate()
				}, iso);
			};
			$[38] = cellClassName;
			$[39] = disabled;
			$[40] = onSelect;
			$[41] = selectedIso;
			$[42] = tone;
			$[43] = t19;
		} else t19 = $[43];
		t18 = cells.map(t19);
		$[31] = cellClassName;
		$[32] = cells;
		$[33] = disabled;
		$[34] = onSelect;
		$[35] = selectedIso;
		$[36] = tone;
		$[37] = t18;
	} else t18 = $[37];
	let t19;
	if ($[44] !== t18) {
		t19 = /* @__PURE__ */ jsx("div", {
			className: "grid grid-cols-7 gap-1",
			children: t18
		});
		$[44] = t18;
		$[45] = t19;
	} else t19 = $[45];
	let t20;
	if ($[46] !== t16 || $[47] !== t19) {
		t20 = /* @__PURE__ */ jsxs(Fragment, { children: [
			t16,
			t17,
			t19
		] });
		$[46] = t16;
		$[47] = t19;
		$[48] = t20;
	} else t20 = $[48];
	return t20;
};
function _temp(day) {
	return /* @__PURE__ */ jsx("div", { children: day }, day);
}
//#endregion
export { CalendarGrid };

//# sourceMappingURL=CalendarGrid.js.map