import { getOrCreateDailyNote } from "./dailyNotes.js";
import { useRepo } from "../../context/repo.js";
import { useBlockOpener } from "../../utils/navigation.js";
import { firstOfMonth, initialDateFromIso } from "./calendar.js";
import { CalendarGrid } from "./CalendarGrid.js";
import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { c } from "react/compiler-runtime";
import { Fragment as Fragment$1, jsx, jsxs } from "react/jsx-runtime";
//#region src/plugins/daily-notes/DailyNotePicker.tsx
var PANEL_WIDTH = 352;
var PANEL_MARGIN = 8;
var pickerPosition = (anchorRect) => {
	if (!anchorRect || typeof window === "undefined") return {
		left: "50%",
		top: 72,
		transform: "translateX(-50%)"
	};
	const availableWidth = window.innerWidth;
	const centeredLeft = anchorRect.left + anchorRect.width / 2 - PANEL_WIDTH / 2;
	return {
		left: Math.min(Math.max(PANEL_MARGIN, centeredLeft), Math.max(PANEL_MARGIN, availableWidth - PANEL_WIDTH - PANEL_MARGIN)),
		top: anchorRect.bottom + PANEL_MARGIN
	};
};
function DailyNotePicker(t0) {
	const $ = c(27);
	const { anchorRect, initialIso, resolve, cancel } = t0;
	const repo = useRepo();
	let t1;
	if ($[0] === Symbol.for("react.memo_cache_sentinel")) {
		t1 = { plainClick: "navigator" };
		$[0] = t1;
	} else t1 = $[0];
	const openBlock = useBlockOpener(t1);
	const panelRef = useRef(null);
	const [selectedIso, setSelectedIso] = useState(initialIso ?? null);
	let t2;
	if ($[1] !== initialIso) {
		t2 = () => firstOfMonth(initialDateFromIso(initialIso));
		$[1] = initialIso;
		$[2] = t2;
	} else t2 = $[2];
	const [visibleMonth, setVisibleMonth] = useState(t2);
	const t3 = anchorRect ?? null;
	let t4;
	if ($[3] !== t3) {
		t4 = pickerPosition(t3);
		$[3] = t3;
		$[4] = t4;
	} else t4 = $[4];
	const position = t4;
	const cancelRef = useRef(cancel);
	let t5;
	if ($[5] !== cancel) {
		t5 = () => {
			cancelRef.current = cancel;
		};
		$[5] = cancel;
		$[6] = t5;
	} else t5 = $[6];
	useEffect(t5);
	let t6;
	let t7;
	if ($[7] === Symbol.for("react.memo_cache_sentinel")) {
		t6 = () => {
			panelRef.current?.focus();
			const handleKeyDown = (event) => {
				if (event.key === "Escape") cancelRef.current();
			};
			window.addEventListener("keydown", handleKeyDown);
			return () => window.removeEventListener("keydown", handleKeyDown);
		};
		t7 = [];
		$[7] = t6;
		$[8] = t7;
	} else {
		t6 = $[7];
		t7 = $[8];
	}
	useEffect(t6, t7);
	let t8;
	if ($[9] !== openBlock || $[10] !== repo || $[11] !== resolve) {
		t8 = async (iso, event_0) => {
			const workspaceId = repo.activeWorkspaceId;
			if (!workspaceId) return;
			setSelectedIso(iso);
			openBlock(event_0, {
				blockId: (await getOrCreateDailyNote(repo, workspaceId, iso)).id,
				workspaceId
			});
			resolve();
		};
		$[9] = openBlock;
		$[10] = repo;
		$[11] = resolve;
		$[12] = t8;
	} else t8 = $[12];
	const openDailyNote = t8;
	let t9;
	if ($[13] !== cancel) {
		t9 = /* @__PURE__ */ jsx("div", {
			className: "fixed inset-0 z-40",
			"aria-hidden": "true",
			onMouseDown: () => cancel()
		});
		$[13] = cancel;
		$[14] = t9;
	} else t9 = $[14];
	let t10;
	if ($[15] !== openDailyNote) {
		t10 = (iso_0, event_1) => void openDailyNote(iso_0, event_1);
		$[15] = openDailyNote;
		$[16] = t10;
	} else t10 = $[16];
	let t11;
	if ($[17] !== selectedIso || $[18] !== t10 || $[19] !== visibleMonth) {
		t11 = /* @__PURE__ */ jsx(CalendarGrid, {
			visibleMonth,
			onVisibleMonthChange: setVisibleMonth,
			selectedIso,
			onSelect: t10,
			variant: "destructive"
		});
		$[17] = selectedIso;
		$[18] = t10;
		$[19] = visibleMonth;
		$[20] = t11;
	} else t11 = $[20];
	let t12;
	if ($[21] !== position || $[22] !== t11) {
		t12 = /* @__PURE__ */ jsx("div", {
			ref: panelRef,
			role: "dialog",
			"aria-label": "Daily note picker",
			tabIndex: -1,
			className: "fixed z-50 w-[min(22rem,calc(100vw-1rem))] rounded-md border bg-popover p-3 text-popover-foreground shadow-lg outline-none",
			style: position,
			children: t11
		});
		$[21] = position;
		$[22] = t11;
		$[23] = t12;
	} else t12 = $[23];
	let t13;
	if ($[24] !== t12 || $[25] !== t9) {
		t13 = createPortal(/* @__PURE__ */ jsxs(Fragment$1, { children: [t9, t12] }), document.body);
		$[24] = t12;
		$[25] = t9;
		$[26] = t13;
	} else t13 = $[26];
	return t13;
}
//#endregion
export { DailyNotePicker };

//# sourceMappingURL=DailyNotePicker.js.map