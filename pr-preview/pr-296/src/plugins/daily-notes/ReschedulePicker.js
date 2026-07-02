import { cn } from "../../lib/utils.js";
import { addDaysIso, todayIso } from "./dailyNotes.js";
import { useRepo } from "../../context/repo.js";
import { useAppRuntime } from "../../extensions/runtimeContext.js";
import { useAnchoredFloating } from "../../components/ui/anchored-floating.js";
import { useIsMobile } from "../../utils/react.js";
import { firstOfMonth, formatDayLabel, fromIso } from "./calendar.js";
import { CalendarGrid } from "./CalendarGrid.js";
import { pickBlockDateAdapter } from "./blockDateAdapter.js";
import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { c } from "react/compiler-runtime";
import { Fragment as Fragment$1, jsx, jsxs } from "react/jsx-runtime";
//#region src/plugins/daily-notes/ReschedulePicker.tsx
/**
* Mobile reschedule sheet — opened by the "Reschedule" quick action on
* the swipe menu, dismissed on commit / outside-tap / Escape.
*
* Layout mirrors what the user sketched in the option-4 + option-1 mix:
*   [ chips:  Today | Tomorrow | +1w | +1m ]
*   [ month grid (tap a day to commit)     ]
*   [ horizontal date strip (scrub/tap)    ]
*
* The sheet asks the `blockDateAdapterFacet` for an adapter the moment
* it opens, then routes both reads ("what's the current date?") and
* writes ("commit this ISO") through that adapter — so SRS blocks adjust
* `srsNextReviewDateProp` while content-date blocks rewrite the inline
* wikilink, all behind the same UI.
*/
var DESKTOP_PANEL_MARGIN = 8;
var DESKTOP_FALLBACK_POSITION = {
	left: "50%",
	position: "fixed",
	top: "50%",
	transform: "translate(-50%, -50%)"
};
var STRIP_PAST_DAYS = 7;
var STRIP_FUTURE_DAYS = 60;
var STRIP_CELL_WIDTH_PX = 48;
var weekdayLetter = (date) => date.toLocaleDateString("en-US", { weekday: "narrow" });
var buildStripCells = (anchorIso) => {
	const today = todayIso();
	const cells = [];
	for (let offset = -STRIP_PAST_DAYS; offset <= STRIP_FUTURE_DAYS; offset++) {
		const iso = addDaysIso(anchorIso, offset);
		const date = fromIso(iso);
		if (!date) continue;
		cells.push({
			iso,
			date,
			isToday: iso === today,
			offsetDays: offset
		});
	}
	return cells;
};
var QUICK_CHIPS = [
	{
		label: "Today",
		offset: 0
	},
	{
		label: "Tomorrow",
		offset: 1
	},
	{
		label: "+1w",
		offset: 7
	},
	{
		label: "+1m",
		offset: 30
	}
];
var ReschedulePicker = (t0) => {
	const $ = c(101);
	const { blockId, anchorRect, resolve, cancel } = t0;
	const runtime = useAppRuntime();
	const repo = useRepo();
	const isMobile = useIsMobile();
	const [session, setSession] = useState(null);
	const [visibleMonth, setVisibleMonth] = useState(_temp);
	const [previewIso, setPreviewIso] = useState(null);
	const [pending, setPending] = useState(false);
	const stripRef = useRef(null);
	const stripDidScrollRef = useRef(false);
	const cancelRef = useRef(cancel);
	let t1;
	if ($[0] !== cancel) {
		t1 = () => {
			cancelRef.current = cancel;
		};
		$[0] = cancel;
		$[1] = t1;
	} else t1 = $[1];
	useEffect(t1);
	let t2;
	let t3;
	if ($[2] !== blockId || $[3] !== repo || $[4] !== runtime) {
		t2 = () => {
			let cancelled = false;
			const block = repo.block(blockId);
			const adapter = pickBlockDateAdapter(runtime, block);
			if (!adapter) {
				console.error(`[reschedule] no adapter handles block ${blockId}`);
				cancelRef.current();
				return;
			}
			(async () => {
				let resolvedIso;
				try {
					resolvedIso = await adapter.getCurrentIso(block);
				} catch (t4) {
					const error = t4;
					console.error(`[reschedule] adapter ${adapter.id} read failed`, error);
					resolvedIso = null;
				}
				if (cancelled) return;
				const initialIso = resolvedIso ?? todayIso();
				const initialDate = fromIso(initialIso) ?? /* @__PURE__ */ new Date();
				setSession({
					adapter,
					initialIso
				});
				setVisibleMonth(firstOfMonth(initialDate));
				setPreviewIso(initialIso);
			})();
			return () => {
				cancelled = true;
			};
		};
		t3 = [
			repo,
			runtime,
			blockId
		];
		$[2] = blockId;
		$[3] = repo;
		$[4] = runtime;
		$[5] = t2;
		$[6] = t3;
	} else {
		t2 = $[5];
		t3 = $[6];
	}
	useEffect(t2, t3);
	let t4;
	let t5;
	if ($[7] !== session) {
		t4 = () => {
			if (!session) return;
			const handleKey = (event) => {
				if (event.key === "Escape") cancelRef.current();
			};
			window.addEventListener("keydown", handleKey);
			return () => window.removeEventListener("keydown", handleKey);
		};
		t5 = [session];
		$[7] = session;
		$[8] = t4;
		$[9] = t5;
	} else {
		t4 = $[8];
		t5 = $[9];
	}
	useEffect(t4, t5);
	let t6;
	if ($[10] !== session) {
		t6 = session ? buildStripCells(session.initialIso) : [];
		$[10] = session;
		$[11] = t6;
	} else t6 = $[11];
	const stripCells = t6;
	const t7 = Boolean(session && !isMobile);
	const t8 = anchorRect ?? null;
	let t9;
	if ($[12] !== t7 || $[13] !== t8) {
		t9 = {
			open: t7,
			anchorRect: t8,
			gap: DESKTOP_PANEL_MARGIN,
			viewportMargin: DESKTOP_PANEL_MARGIN,
			fallbackStyle: DESKTOP_FALLBACK_POSITION
		};
		$[12] = t7;
		$[13] = t8;
		$[14] = t9;
	} else t9 = $[14];
	const desktopFloating = useAnchoredFloating(t9);
	const desktopPosition = isMobile ? void 0 : desktopFloating.floatingStyle;
	let t10;
	let t11;
	if ($[15] !== session) {
		t10 = () => {
			if (!session || !stripRef.current || stripDidScrollRef.current) return;
			const container = stripRef.current;
			const targetScrollLeft = STRIP_PAST_DAYS * STRIP_CELL_WIDTH_PX - container.clientWidth / 2 + STRIP_CELL_WIDTH_PX / 2;
			container.scrollLeft = Math.max(0, targetScrollLeft);
			stripDidScrollRef.current = true;
		};
		t11 = [session];
		$[15] = session;
		$[16] = t10;
		$[17] = t11;
	} else {
		t10 = $[16];
		t11 = $[17];
	}
	useEffect(t10, t11);
	if (!session) return null;
	let commit;
	let t12;
	let t13;
	let t14;
	let t15;
	let t16;
	let t17;
	let t18;
	let t19;
	let t20;
	let t21;
	let t22;
	let t23;
	let t24;
	if ($[18] !== blockId || $[19] !== cancel || $[20] !== desktopFloating || $[21] !== desktopPosition || $[22] !== isMobile || $[23] !== pending || $[24] !== previewIso || $[25] !== repo || $[26] !== resolve || $[27] !== session) {
		const today = todayIso();
		let t25;
		if ($[42] !== blockId || $[43] !== pending || $[44] !== repo || $[45] !== resolve || $[46] !== session) {
			t25 = async (iso) => {
				if (!session || pending) return;
				setPending(true);
				let wrote = false;
				try {
					const block_0 = repo.block(blockId);
					wrote = await session.adapter.setIso(block_0, iso);
					if (!wrote) console.warn(`[reschedule] adapter ${session.adapter.id} refused write`);
				} catch (t26) {
					const error_0 = t26;
					console.error(`[reschedule] adapter ${session.adapter.id} threw on write`, error_0);
				}
				resolve({ rescheduled: wrote });
			};
			$[42] = blockId;
			$[43] = pending;
			$[44] = repo;
			$[45] = resolve;
			$[46] = session;
			$[47] = t25;
		} else t25 = $[47];
		commit = t25;
		let t26;
		if ($[48] !== previewIso) {
			const previewDate = previewIso ? fromIso(previewIso) : null;
			t26 = previewDate ? formatDayLabel(previewDate) : "—";
			$[48] = previewIso;
			$[49] = t26;
		} else t26 = $[49];
		const previewLabel = t26;
		const sheetClassName = isMobile ? "fixed inset-x-0 bottom-0 z-50 max-h-[85vh] overflow-y-auto rounded-t-2xl border-t bg-popover px-4 pb-[calc(env(safe-area-inset-bottom)+1rem)] pt-3 text-popover-foreground shadow-2xl" : "fixed z-50 max-h-[calc(100vh-1rem)] w-[min(28rem,calc(100vw-2rem))] overflow-y-auto rounded-2xl border bg-popover p-4 text-popover-foreground shadow-2xl";
		t24 = createPortal;
		if ($[50] !== cancel) {
			t23 = /* @__PURE__ */ jsx("div", {
				className: "fixed inset-0 z-40 bg-black/30 backdrop-blur-[1px]",
				"aria-hidden": "true",
				onClick: () => cancel()
			});
			$[50] = cancel;
			$[51] = t23;
		} else t23 = $[51];
		t14 = isMobile ? void 0 : desktopFloating.setFloatingElement;
		t15 = "dialog";
		t16 = "Reschedule block";
		t17 = pending || void 0;
		t18 = sheetClassName;
		t19 = desktopPosition;
		t20 = _temp2;
		if ($[52] !== isMobile) {
			t21 = isMobile && /* @__PURE__ */ jsx("div", {
				className: "mx-auto mb-2 h-1 w-10 rounded-full bg-muted-foreground/30",
				"aria-hidden": "true"
			});
			$[52] = isMobile;
			$[53] = t21;
		} else t21 = $[53];
		let t27;
		if ($[54] === Symbol.for("react.memo_cache_sentinel")) {
			t27 = /* @__PURE__ */ jsx("div", {
				className: "text-sm font-medium text-muted-foreground",
				children: "Reschedule to"
			});
			$[54] = t27;
		} else t27 = $[54];
		if ($[55] !== previewLabel) {
			t22 = /* @__PURE__ */ jsxs("div", {
				className: "mb-3 flex items-baseline justify-between gap-3",
				children: [t27, /* @__PURE__ */ jsx("div", {
					className: "truncate text-base font-semibold",
					children: previewLabel
				})]
			});
			$[55] = previewLabel;
			$[56] = t22;
		} else t22 = $[56];
		t12 = "mb-3 flex flex-wrap gap-2";
		t13 = QUICK_CHIPS.map((chip) => {
			const iso_0 = addDaysIso(today, chip.offset);
			return /* @__PURE__ */ jsx("button", {
				type: "button",
				disabled: pending,
				onClick: () => {
					setPreviewIso(iso_0);
					commit(iso_0);
				},
				className: cn("rounded-full border px-3 py-1.5 text-xs font-medium transition-colors active:scale-95", previewIso === iso_0 ? "border-primary bg-primary text-primary-foreground" : "border-border bg-background text-foreground hover:bg-muted"),
				children: chip.label
			}, chip.label);
		});
		$[18] = blockId;
		$[19] = cancel;
		$[20] = desktopFloating;
		$[21] = desktopPosition;
		$[22] = isMobile;
		$[23] = pending;
		$[24] = previewIso;
		$[25] = repo;
		$[26] = resolve;
		$[27] = session;
		$[28] = commit;
		$[29] = t12;
		$[30] = t13;
		$[31] = t14;
		$[32] = t15;
		$[33] = t16;
		$[34] = t17;
		$[35] = t18;
		$[36] = t19;
		$[37] = t20;
		$[38] = t21;
		$[39] = t22;
		$[40] = t23;
		$[41] = t24;
	} else {
		commit = $[28];
		t12 = $[29];
		t13 = $[30];
		t14 = $[31];
		t15 = $[32];
		t16 = $[33];
		t17 = $[34];
		t18 = $[35];
		t19 = $[36];
		t20 = $[37];
		t21 = $[38];
		t22 = $[39];
		t23 = $[40];
		t24 = $[41];
	}
	let t25;
	if ($[57] !== t12 || $[58] !== t13) {
		t25 = /* @__PURE__ */ jsx("div", {
			className: t12,
			children: t13
		});
		$[57] = t12;
		$[58] = t13;
		$[59] = t25;
	} else t25 = $[59];
	let t26;
	if ($[60] !== commit) {
		t26 = (iso_1) => {
			setPreviewIso(iso_1);
			commit(iso_1);
		};
		$[60] = commit;
		$[61] = t26;
	} else t26 = $[61];
	let t27;
	if ($[62] !== pending || $[63] !== previewIso || $[64] !== t26 || $[65] !== visibleMonth) {
		t27 = /* @__PURE__ */ jsx(CalendarGrid, {
			visibleMonth,
			onVisibleMonthChange: setVisibleMonth,
			selectedIso: previewIso,
			onSelect: t26,
			disabled: pending,
			variant: "primary"
		});
		$[62] = pending;
		$[63] = previewIso;
		$[64] = t26;
		$[65] = visibleMonth;
		$[66] = t27;
	} else t27 = $[66];
	let t28;
	if ($[67] === Symbol.for("react.memo_cache_sentinel")) {
		t28 = /* @__PURE__ */ jsxs("div", {
			className: "mb-1 flex items-center justify-between text-xs text-muted-foreground",
			children: [/* @__PURE__ */ jsx("span", { children: "Quick scrub" }), /* @__PURE__ */ jsx("span", {
				className: "text-[10px] uppercase tracking-wide",
				children: "tap a day"
			})]
		});
		$[67] = t28;
	} else t28 = $[67];
	let t29;
	if ($[68] !== commit || $[69] !== pending || $[70] !== previewIso || $[71] !== stripCells) {
		let t30;
		if ($[73] !== commit || $[74] !== pending || $[75] !== previewIso) {
			t30 = (cell) => {
				const isSelected_0 = cell.iso === previewIso;
				return /* @__PURE__ */ jsxs("button", {
					type: "button",
					disabled: pending,
					role: "option",
					"aria-selected": isSelected_0,
					"aria-label": formatDayLabel(cell.date),
					onClick: () => {
						setPreviewIso(cell.iso);
						commit(cell.iso);
					},
					style: {
						width: STRIP_CELL_WIDTH_PX,
						scrollSnapAlign: "center"
					},
					className: cn("flex shrink-0 flex-col items-center justify-center rounded-md border py-2 transition-colors active:scale-95", isSelected_0 ? "border-primary bg-primary text-primary-foreground" : cell.isToday ? "border-primary bg-primary/10 text-primary" : "border-border bg-background text-foreground hover:bg-muted"),
					children: [
						/* @__PURE__ */ jsx("span", {
							className: "text-[10px] font-medium uppercase tracking-wide opacity-70",
							children: weekdayLetter(cell.date)
						}),
						/* @__PURE__ */ jsx("span", {
							className: "text-base font-semibold leading-tight",
							children: cell.date.getDate()
						}),
						/* @__PURE__ */ jsx("span", {
							className: "text-[9px] opacity-60",
							children: cell.isToday ? "today" : cell.offsetDays === 0 ? "original" : cell.offsetDays > 0 ? `+${cell.offsetDays}d` : `${cell.offsetDays}d`
						})
					]
				}, cell.iso);
			};
			$[73] = commit;
			$[74] = pending;
			$[75] = previewIso;
			$[76] = t30;
		} else t30 = $[76];
		t29 = stripCells.map(t30);
		$[68] = commit;
		$[69] = pending;
		$[70] = previewIso;
		$[71] = stripCells;
		$[72] = t29;
	} else t29 = $[72];
	let t30;
	if ($[77] !== t29) {
		t30 = /* @__PURE__ */ jsxs("div", {
			className: "mt-3 border-t pt-3",
			children: [t28, /* @__PURE__ */ jsx("div", {
				ref: stripRef,
				className: "-mx-4 flex snap-x snap-mandatory gap-1 overflow-x-auto px-4 pb-1",
				role: "listbox",
				"aria-label": "Date strip",
				children: t29
			})]
		});
		$[77] = t29;
		$[78] = t30;
	} else t30 = $[78];
	let t31;
	if ($[79] !== cancel) {
		t31 = /* @__PURE__ */ jsx("button", {
			type: "button",
			onClick: () => cancel(),
			className: "mt-3 w-full rounded-md border bg-background py-2 text-sm font-medium text-foreground hover:bg-muted",
			children: "Cancel"
		});
		$[79] = cancel;
		$[80] = t31;
	} else t31 = $[80];
	let t32;
	if ($[81] !== t14 || $[82] !== t15 || $[83] !== t16 || $[84] !== t17 || $[85] !== t18 || $[86] !== t19 || $[87] !== t20 || $[88] !== t21 || $[89] !== t22 || $[90] !== t25 || $[91] !== t27 || $[92] !== t30 || $[93] !== t31) {
		t32 = /* @__PURE__ */ jsxs("div", {
			ref: t14,
			role: t15,
			"aria-label": t16,
			"aria-busy": t17,
			className: t18,
			style: t19,
			onClick: t20,
			children: [
				t21,
				t22,
				t25,
				t27,
				t30,
				t31
			]
		});
		$[81] = t14;
		$[82] = t15;
		$[83] = t16;
		$[84] = t17;
		$[85] = t18;
		$[86] = t19;
		$[87] = t20;
		$[88] = t21;
		$[89] = t22;
		$[90] = t25;
		$[91] = t27;
		$[92] = t30;
		$[93] = t31;
		$[94] = t32;
	} else t32 = $[94];
	let t33;
	if ($[95] !== t23 || $[96] !== t32) {
		t33 = /* @__PURE__ */ jsxs(Fragment$1, { children: [t23, t32] });
		$[95] = t23;
		$[96] = t32;
		$[97] = t33;
	} else t33 = $[97];
	let t34;
	if ($[98] !== t24 || $[99] !== t33) {
		t34 = t24(t33, document.body);
		$[98] = t24;
		$[99] = t33;
		$[100] = t34;
	} else t34 = $[100];
	return t34;
};
function _temp() {
	return firstOfMonth(/* @__PURE__ */ new Date());
}
function _temp2(event_0) {
	return event_0.stopPropagation();
}
//#endregion
export { ReschedulePicker };

//# sourceMappingURL=ReschedulePicker.js.map