import { activePanelIdProp } from "../../data/properties.js";
import { useHandle, usePropertyValue } from "../../hooks/block.js";
import { NestedBlockContextProvider } from "../../context/block.js";
import { isPanelStackRow, panelRowsInLayoutOrder } from "../../utils/panelLayoutProjection.js";
import { useIsMobile } from "../../utils/react.js";
import { BlockComponent } from "../BlockComponent.js";
import { useEffect } from "react";
import { c } from "react/compiler-runtime";
import { jsx } from "react/jsx-runtime";
//#region src/components/renderer/LayoutRenderer.tsx
var EMPTY_ROWS = Object.freeze([]);
var TOP_LEVEL_COLUMN_CLASS = "h-full w-full min-w-0 max-w-3xl shrink-0 border-l border-border pl-2 first:border-l-0 first:pl-0 only:mx-auto md:min-w-md md:basis-0 md:grow md:shrink";
var WIDE_SCROLL_COLUMN_CLASS = "h-full w-full min-w-0 shrink-0 border-l border-border pl-2 first:border-l-0 first:pl-0";
var STACK_CHILD_CLASS = "w-full min-w-0 shrink-0 border-t border-border pt-2 first:border-t-0 first:pt-0";
var buildRenderSlots = (rootId, rows) => {
	const childrenByParent = /* @__PURE__ */ new Map();
	for (const row of rows) {
		if (!row.parentId) continue;
		const children = childrenByParent.get(row.parentId) ?? [];
		children.push(row);
		childrenByParent.set(row.parentId, children);
	}
	const visit = (row) => {
		if (isPanelStackRow(row)) return {
			kind: "stack",
			id: row.id,
			children: (childrenByParent.get(row.id) ?? []).map(visit)
		};
		return {
			kind: "panel",
			id: row.id
		};
	};
	return (childrenByParent.get(rootId) ?? []).map(visit);
};
var flattenPanelSlots = (slots) => slots.flatMap((slot) => slot.kind === "panel" ? [slot] : flattenPanelSlots(slot.children));
function PanelSlotView(t0) {
	const $ = c(21);
	const { slot, layoutSessionBlock, canClosePanel, className, stacked, wideScrollSurface, trackFocus, columnId } = t0;
	let t1;
	if ($[0] !== layoutSessionBlock || $[1] !== slot.id) {
		t1 = () => {
			if (layoutSessionBlock.peekProperty(activePanelIdProp) === slot.id) return;
			layoutSessionBlock.set(activePanelIdProp, slot.id);
		};
		$[0] = layoutSessionBlock;
		$[1] = slot.id;
		$[2] = t1;
	} else t1 = $[2];
	const markActivePanel = t1;
	let t2;
	if ($[3] !== canClosePanel || $[4] !== layoutSessionBlock.id || $[5] !== slot.id || $[6] !== stacked || $[7] !== wideScrollSurface) {
		t2 = {
			layoutBoundary: true,
			panelId: slot.id,
			layoutSessionBlockId: layoutSessionBlock.id,
			canClosePanel,
			stackedPanel: stacked,
			wideScrollSurface
		};
		$[3] = canClosePanel;
		$[4] = layoutSessionBlock.id;
		$[5] = slot.id;
		$[6] = stacked;
		$[7] = wideScrollSurface;
		$[8] = t2;
	} else t2 = $[8];
	const t3 = trackFocus ? markActivePanel : void 0;
	let t4;
	if ($[9] !== slot.id) {
		t4 = /* @__PURE__ */ jsx(BlockComponent, { blockId: slot.id });
		$[9] = slot.id;
		$[10] = t4;
	} else t4 = $[10];
	let t5;
	if ($[11] !== className || $[12] !== columnId || $[13] !== markActivePanel || $[14] !== t3 || $[15] !== t4) {
		t5 = /* @__PURE__ */ jsx("div", {
			"data-layout-column-id": columnId,
			className,
			onPointerDownCapture: markActivePanel,
			onFocusCapture: t3,
			children: t4
		});
		$[11] = className;
		$[12] = columnId;
		$[13] = markActivePanel;
		$[14] = t3;
		$[15] = t4;
		$[16] = t5;
	} else t5 = $[16];
	let t6;
	if ($[17] !== slot.id || $[18] !== t2 || $[19] !== t5) {
		t6 = /* @__PURE__ */ jsx(NestedBlockContextProvider, {
			overrides: t2,
			children: t5
		}, slot.id);
		$[17] = slot.id;
		$[18] = t2;
		$[19] = t5;
		$[20] = t6;
	} else t6 = $[20];
	return t6;
}
function SlotView(t0) {
	const $ = c(23);
	const { slot, layoutSessionBlock, canClosePanel, topLevel, wideScrollSurface, trackFocus } = t0;
	if (slot.kind === "panel") {
		const t1 = topLevel ? wideScrollSurface ? WIDE_SCROLL_COLUMN_CLASS : TOP_LEVEL_COLUMN_CLASS : STACK_CHILD_CLASS;
		const t2 = !topLevel;
		const t3 = topLevel ? slot.id : void 0;
		let t4;
		if ($[0] !== canClosePanel || $[1] !== layoutSessionBlock || $[2] !== slot || $[3] !== t1 || $[4] !== t2 || $[5] !== t3 || $[6] !== trackFocus || $[7] !== wideScrollSurface) {
			t4 = /* @__PURE__ */ jsx(PanelSlotView, {
				slot,
				layoutSessionBlock,
				canClosePanel,
				className: t1,
				stacked: t2,
				wideScrollSurface,
				trackFocus,
				columnId: t3
			});
			$[0] = canClosePanel;
			$[1] = layoutSessionBlock;
			$[2] = slot;
			$[3] = t1;
			$[4] = t2;
			$[5] = t3;
			$[6] = trackFocus;
			$[7] = wideScrollSurface;
			$[8] = t4;
		} else t4 = $[8];
		return t4;
	}
	const t1 = slot.id;
	const t2 = topLevel ? slot.id : void 0;
	const t3 = `${topLevel ? TOP_LEVEL_COLUMN_CLASS : STACK_CHILD_CLASS} flex flex-col gap-2 overflow-y-auto pr-1`;
	let t4;
	if ($[9] !== canClosePanel || $[10] !== layoutSessionBlock || $[11] !== slot.children || $[12] !== trackFocus) {
		let t5;
		if ($[14] !== canClosePanel || $[15] !== layoutSessionBlock || $[16] !== trackFocus) {
			t5 = (child) => /* @__PURE__ */ jsx(SlotView, {
				slot: child,
				layoutSessionBlock,
				canClosePanel,
				topLevel: false,
				wideScrollSurface: false,
				trackFocus
			}, child.id);
			$[14] = canClosePanel;
			$[15] = layoutSessionBlock;
			$[16] = trackFocus;
			$[17] = t5;
		} else t5 = $[17];
		t4 = slot.children.map(t5);
		$[9] = canClosePanel;
		$[10] = layoutSessionBlock;
		$[11] = slot.children;
		$[12] = trackFocus;
		$[13] = t4;
	} else t4 = $[13];
	let t5;
	if ($[18] !== slot.id || $[19] !== t2 || $[20] !== t3 || $[21] !== t4) {
		t5 = /* @__PURE__ */ jsx("div", {
			"data-layout-column-id": t2,
			className: t3,
			children: t4
		}, t1);
		$[18] = slot.id;
		$[19] = t2;
		$[20] = t3;
		$[21] = t4;
		$[22] = t5;
	} else t5 = $[22];
	return t5;
}
function LayoutRenderer(t0) {
	const $ = c(45);
	const { block } = t0;
	const isMobile = useIsMobile();
	const [activePanelId] = usePropertyValue(block, activePanelIdProp);
	let t1;
	if ($[0] !== block.id || $[1] !== block.repo.query) {
		t1 = block.repo.query.subtree({ id: block.id });
		$[0] = block.id;
		$[1] = block.repo.query;
		$[2] = t1;
	} else t1 = $[2];
	let t2;
	if ($[3] === Symbol.for("react.memo_cache_sentinel")) {
		t2 = { selector: _temp };
		$[3] = t2;
	} else t2 = $[3];
	const rows = useHandle(t1, t2);
	let t3;
	if ($[4] !== block.id || $[5] !== rows) {
		t3 = buildRenderSlots(block.id, rows);
		$[4] = block.id;
		$[5] = rows;
		$[6] = t3;
	} else t3 = $[6];
	const slots = t3;
	let t4;
	if ($[7] !== block.id || $[8] !== rows) {
		t4 = new Set(panelRowsInLayoutOrder(block.id, rows).map(_temp2));
		$[7] = block.id;
		$[8] = rows;
		$[9] = t4;
	} else t4 = $[9];
	const panelIds = t4;
	let t5;
	if ($[10] !== panelIds || $[11] !== slots) {
		let t6;
		if ($[13] !== panelIds) {
			t6 = (slot) => panelIds.has(slot.id);
			$[13] = panelIds;
			$[14] = t6;
		} else t6 = $[14];
		t5 = flattenPanelSlots(slots).filter(t6);
		$[10] = panelIds;
		$[11] = slots;
		$[12] = t5;
	} else t5 = $[12];
	const panelSlots = t5;
	let t6;
	if ($[15] !== activePanelId || $[16] !== panelSlots) {
		t6 = activePanelId ? panelSlots.find((slot_0) => slot_0.id === activePanelId) : void 0;
		$[15] = activePanelId;
		$[16] = panelSlots;
		$[17] = t6;
	} else t6 = $[17];
	const activePanelSlot = t6;
	let t7;
	if ($[18] !== isMobile || $[19] !== panelSlots) {
		t7 = isMobile ? panelSlots.at(-1) : panelSlots[0];
		$[18] = isMobile;
		$[19] = panelSlots;
		$[20] = t7;
	} else t7 = $[20];
	const fallbackActivePanelSlot = t7;
	const mobilePanelSlot = activePanelSlot ?? fallbackActivePanelSlot;
	let t8;
	if ($[21] !== isMobile || $[22] !== mobilePanelSlot || $[23] !== slots) {
		t8 = isMobile ? mobilePanelSlot ? [mobilePanelSlot] : [] : slots;
		$[21] = isMobile;
		$[22] = mobilePanelSlot;
		$[23] = slots;
		$[24] = t8;
	} else t8 = $[24];
	const slotsToRender = t8;
	const canClosePanel = panelSlots.length > 1;
	const hasOneVisiblePanel = slotsToRender.length === 1 && slotsToRender[0]?.kind === "panel";
	let t10;
	let t9;
	if ($[25] !== activePanelId || $[26] !== activePanelSlot || $[27] !== block || $[28] !== fallbackActivePanelSlot) {
		t9 = () => {
			if (!fallbackActivePanelSlot || activePanelSlot || activePanelId) return;
			block.set(activePanelIdProp, fallbackActivePanelSlot.id);
		};
		t10 = [
			block,
			activePanelId,
			activePanelSlot,
			fallbackActivePanelSlot
		];
		$[25] = activePanelId;
		$[26] = activePanelSlot;
		$[27] = block;
		$[28] = fallbackActivePanelSlot;
		$[29] = t10;
		$[30] = t9;
	} else {
		t10 = $[29];
		t9 = $[30];
	}
	useEffect(t9, t10);
	const t11 = block.id;
	let t12;
	if ($[31] !== block || $[32] !== canClosePanel || $[33] !== hasOneVisiblePanel || $[34] !== isMobile || $[35] !== slotsToRender) {
		let t13;
		if ($[37] !== block || $[38] !== canClosePanel || $[39] !== hasOneVisiblePanel || $[40] !== isMobile) {
			t13 = (slot_1) => /* @__PURE__ */ jsx(SlotView, {
				slot: slot_1,
				layoutSessionBlock: block,
				canClosePanel,
				topLevel: true,
				wideScrollSurface: hasOneVisiblePanel && slot_1.kind === "panel",
				trackFocus: !isMobile
			}, slot_1.id);
			$[37] = block;
			$[38] = canClosePanel;
			$[39] = hasOneVisiblePanel;
			$[40] = isMobile;
			$[41] = t13;
		} else t13 = $[41];
		t12 = slotsToRender.map(t13);
		$[31] = block;
		$[32] = canClosePanel;
		$[33] = hasOneVisiblePanel;
		$[34] = isMobile;
		$[35] = slotsToRender;
		$[36] = t12;
	} else t12 = $[36];
	let t13;
	if ($[42] !== block.id || $[43] !== t12) {
		t13 = /* @__PURE__ */ jsx("div", {
			"data-layout-session-id": t11,
			className: "layout flex min-w-0 flex-row flex-grow justify-start overflow-x-auto h-full",
			children: t12
		});
		$[42] = block.id;
		$[43] = t12;
		$[44] = t13;
	} else t13 = $[44];
	return t13;
}
function _temp2(row) {
	return row.id;
}
function _temp(data) {
	return data ?? EMPTY_ROWS;
}
LayoutRenderer.canRender = ({ context }) => !!(context && !context.layoutBoundary && !context.panelId);
LayoutRenderer.priority = () => 20;
//#endregion
export { LayoutRenderer };

//# sourceMappingURL=LayoutRenderer.js.map