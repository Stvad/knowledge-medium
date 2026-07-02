import { topLevelBlockIdProp } from "../../data/properties.js";
import clamp from "../../../node_modules/lodash-es/clamp.js";
import { usePropertyValue } from "../../hooks/block.js";
import { useAppRuntime } from "../../extensions/runtimeContext.js";
import { Ellipsis } from "../../../node_modules/lucide-react/dist/esm/icons/ellipsis.js";
import { useUIStateBlock } from "../../data/globalState.js";
import { useIsMobile } from "../../utils/react.js";
import { getEffectiveActions } from "../../shortcuts/effectiveActions.js";
import { dispatchActionWithDeps } from "../../shortcuts/runAction.js";
import { quickActionItemsFacet } from "./actions.js";
import { SWIPE_QUICK_ACTION_CLOSE_EVENT, SWIPE_QUICK_ACTION_OPEN_EVENT, SWIPE_QUICK_ACTION_PROGRESS_EVENT, SWIPE_QUICK_ACTION_RUN_EVENT, isSwipeQuickActionMenuEvent, isSwipeQuickActionProgressEvent, isSwipeQuickActionRunEvent } from "./events.js";
import { findSwipeActionAnchorElement, findSwipeActionBlockElement, getSwipeActionAnchorRect } from "./anchor.js";
import "./swipeRecognizer.js";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { c } from "react/compiler-runtime";
import { Fragment as Fragment$1, jsx, jsxs } from "react/jsx-runtime";
//#region src/plugins/swipe-quick-actions/SwipeActionMenu.tsx
/** Track the swiped block content's bounding rect so the floating bar
*  follows the visible text row, not the full block shell with open
*  properties or children.
*
*  `panelRoot` scopes the lookup so the same block id rendered in
*  another panel can't be picked up here — Codex's panel-disambiguation
*  guard. The panel-local event listener means each panel's menu only
*  opens from its own swiped block id, but the scope still matters inside
*  one panel: if a block is transcluded via embed, renderScopeId narrows
*  the lookup to the exact rendered occurrence. */
var useAnchorRect = (panelRoot, blockId, renderScopeId) => {
	const $ = c(5);
	const [rect, setRect] = useState(null);
	const trackedKey = blockId && panelRoot ? `${blockId}\u0000${renderScopeId ?? ""}` : null;
	const [tracked, setTracked] = useState(trackedKey);
	if (tracked !== trackedKey) {
		setTracked(trackedKey);
		setRect(null);
	}
	let t0;
	let t1;
	if ($[0] !== blockId || $[1] !== panelRoot || $[2] !== renderScopeId) {
		t0 = () => {
			if (!panelRoot || !blockId) return;
			const find = () => findSwipeActionAnchorElement(panelRoot, blockId, renderScopeId);
			const measure = () => {
				const nextRect = getSwipeActionAnchorRect(panelRoot, blockId, renderScopeId);
				if (!nextRect) {
					setRect(null);
					return;
				}
				setRect(nextRect);
			};
			measure();
			window.addEventListener("scroll", measure, true);
			window.addEventListener("resize", measure);
			let raf = 0;
			const observer = new ResizeObserver(() => {
				cancelAnimationFrame(raf);
				raf = requestAnimationFrame(measure);
			});
			const targetEl = find();
			if (targetEl) observer.observe(targetEl);
			return () => {
				window.removeEventListener("scroll", measure, true);
				window.removeEventListener("resize", measure);
				cancelAnimationFrame(raf);
				observer.disconnect();
			};
		};
		t1 = [
			panelRoot,
			blockId,
			renderScopeId
		];
		$[0] = blockId;
		$[1] = panelRoot;
		$[2] = renderScopeId;
		$[3] = t0;
		$[4] = t1;
	} else {
		t0 = $[3];
		t1 = $[4];
	}
	useLayoutEffect(t0, t1);
	return rect;
};
var TOOLBAR_ROW_HEIGHT_PX = 28;
/** Drag distance at which the toolbar is fully revealed during a
*  preview. Intentionally larger than `SWIPE_TRIGGER_PX` so releasing
*  at the commit threshold still has room for a satisfying "complete
*  the appearance" snap (think the Workflowy left-swipe pull-out). */
var PREVIEW_FULL_REVEAL_PX = 100;
/** Duration of the snap-to-resting-state animation after the finger
*  lifts. Long enough to read, short enough to feel responsive. */
var SETTLE_DURATION_MS = 200;
/** Map an opening-drag delta (dx ≤ 0) to the toolbar's hide percent —
*  0 = fully visible, 100 = parked off-screen right. */
var computeOpenHidePercent = (dx) => clamp(100 + dx / PREVIEW_FULL_REVEAL_PX * 100, 0, 100);
/** Same mapping for a close-drag on an already-open menu (dx ≥ 0). */
var computeCloseHidePercent = (dx) => clamp(dx / PREVIEW_FULL_REVEAL_PX * 100, 0, 100);
/** Build a render-ready view for the toolbar from `(items, registry)`,
*  so the JSX below stays focused on layout. */
var resolveActions = (items, registry) => items.map((item) => {
	const action = registry.find((a) => a.id === item.actionId);
	return {
		item,
		action,
		Icon: action?.icon,
		label: item.label ?? action?.description ?? item.actionId
	};
});
var swipeTargetKey = (blockId, renderScopeId) => blockId ? `${blockId}\u0000${renderScopeId ?? ""}` : null;
var sameSwipeTarget = (leftBlockId, leftRenderScopeId, rightBlockId, rightRenderScopeId) => leftBlockId === rightBlockId && leftRenderScopeId === rightRenderScopeId;
var ActionButton = (t0) => {
	const $ = c(11);
	const { resolved, onRun } = t0;
	const { Icon, label, item } = resolved;
	const hasIcon = Boolean(Icon);
	let t1;
	if ($[0] !== onRun || $[1] !== resolved) {
		t1 = (event) => {
			event.preventDefault();
			event.stopPropagation();
			onRun(resolved);
		};
		$[0] = onRun;
		$[1] = resolved;
		$[2] = t1;
	} else t1 = $[2];
	const handleClick = t1;
	const t2 = `flex h-7 items-center justify-center rounded transition-colors active:bg-accent ${hasIcon ? "w-7" : "min-w-11 max-w-[5.5rem] px-2 text-[11px] font-medium leading-none"} ${item.destructive ? "text-destructive hover:bg-destructive/10 active:bg-destructive/20" : "text-foreground hover:bg-muted"}`;
	let t3;
	if ($[3] !== Icon || $[4] !== label) {
		t3 = Icon ? /* @__PURE__ */ jsx(Icon, { className: "h-4 w-4" }) : /* @__PURE__ */ jsx("span", {
			className: "overflow-hidden text-ellipsis whitespace-nowrap",
			children: label
		});
		$[3] = Icon;
		$[4] = label;
		$[5] = t3;
	} else t3 = $[5];
	let t4;
	if ($[6] !== handleClick || $[7] !== label || $[8] !== t2 || $[9] !== t3) {
		t4 = /* @__PURE__ */ jsx("button", {
			type: "button",
			"aria-label": label,
			title: label,
			"data-block-interaction": "ignore",
			onClick: handleClick,
			className: t2,
			children: t3
		});
		$[6] = handleClick;
		$[7] = label;
		$[8] = t2;
		$[9] = t3;
		$[10] = t4;
	} else t4 = $[10];
	return t4;
};
/** Floating action bar that appears when a block in this panel is
*  swiped left. Mounted via `blockHeaderFacet` on each panel's
*  top-level block, so each panel has its own independent menu and
*  the same block id rendered in two panels can't confuse anchoring.
*
*  Mobile-only: desktop has a right-click context menu on the bullet,
*  and the gesture handler likewise gates on mobile by virtue of not
*  firing without touch input — this component just hides outright to
*  avoid mounting cost on desktop.
*
*  `blockHeaderFacet` passes a `{block}` prop (the panel row); we read
*  the same panel's UI-state block only for action dependencies and keep
*  the currently open menu target in local React state. */
var SwipeActionMenu = () => {
	const $ = c(117);
	const isMobile = useIsMobile();
	const uiStateBlock = useUIStateBlock();
	const repo = uiStateBlock.repo;
	const runtime = useAppRuntime();
	const [topLevelBlockId] = usePropertyValue(uiStateBlock, topLevelBlockIdProp);
	const [activeBlockId, setActiveBlockId] = useState(void 0);
	const [activeRenderScopeId, setActiveRenderScopeId] = useState(void 0);
	const inlineAnchorRef = useRef(null);
	const [panelRoot, setPanelRoot] = useState(null);
	let t0;
	let t1;
	if ($[0] === Symbol.for("react.memo_cache_sentinel")) {
		t0 = () => {
			setPanelRoot(inlineAnchorRef.current?.closest(".panel") ?? null);
		};
		t1 = [];
		$[0] = t0;
		$[1] = t1;
	} else {
		t0 = $[0];
		t1 = $[1];
	}
	useLayoutEffect(t0, t1);
	const [previewBlockId, setPreviewBlockId] = useState(null);
	const [previewRenderScopeId, setPreviewRenderScopeId] = useState(void 0);
	const [dragOffsetPercent, setDragOffsetPercent] = useState(null);
	const [isSettling, setIsSettling] = useState(false);
	const settleTimerRef = useRef(null);
	const settleTargetRef = useRef(null);
	const anchor = useAnchorRect(isMobile ? panelRoot : null, isMobile ? previewBlockId ?? activeBlockId : void 0, isMobile ? previewBlockId ? previewRenderScopeId : activeRenderScopeId : void 0);
	const [showOverflow, setShowOverflow] = useState(false);
	const containerRef = useRef(null);
	const menuTouchStartRef = useRef(null);
	let t2;
	if ($[2] === Symbol.for("react.memo_cache_sentinel")) {
		t2 = () => {
			if (settleTimerRef.current !== null) {
				window.clearTimeout(settleTimerRef.current);
				settleTimerRef.current = null;
			}
			settleTargetRef.current = null;
		};
		$[2] = t2;
	} else t2 = $[2];
	const clearSettleTimer = t2;
	let t3;
	if ($[3] === Symbol.for("react.memo_cache_sentinel")) {
		t3 = (target) => {
			if (settleTimerRef.current !== null) window.clearTimeout(settleTimerRef.current);
			settleTargetRef.current = target;
			setIsSettling(true);
			setDragOffsetPercent(target === "open" ? 0 : 100);
			settleTimerRef.current = window.setTimeout(() => {
				settleTimerRef.current = null;
				const finalTarget = settleTargetRef.current;
				settleTargetRef.current = null;
				setIsSettling(false);
				setPreviewBlockId(null);
				setPreviewRenderScopeId(void 0);
				setDragOffsetPercent(null);
				if (finalTarget === "closed") {
					setActiveBlockId(void 0);
					setActiveRenderScopeId(void 0);
				}
			}, SETTLE_DURATION_MS);
		};
		$[3] = t3;
	} else t3 = $[3];
	const startSettle = t3;
	let t4;
	if ($[4] === Symbol.for("react.memo_cache_sentinel")) {
		t4 = () => () => clearSettleTimer();
		$[4] = t4;
	} else t4 = $[4];
	let t5;
	if ($[5] !== topLevelBlockId) {
		t5 = [clearSettleTimer, topLevelBlockId];
		$[5] = topLevelBlockId;
		$[6] = t5;
	} else t5 = $[6];
	useEffect(t4, t5);
	let t6;
	if ($[7] === Symbol.for("react.memo_cache_sentinel")) {
		t6 = () => {
			clearSettleTimer();
			setActiveBlockId(void 0);
			setActiveRenderScopeId(void 0);
			setPreviewBlockId(null);
			setPreviewRenderScopeId(void 0);
			setDragOffsetPercent(null);
			setIsSettling(false);
		};
		$[7] = t6;
	} else t6 = $[7];
	const dismiss = t6;
	let t7;
	if ($[8] !== runtime) {
		t7 = getEffectiveActions(runtime);
		$[8] = runtime;
		$[9] = t7;
	} else t7 = $[9];
	const allActions = t7;
	let t8;
	if ($[10] !== repo || $[11] !== topLevelBlockId || $[12] !== uiStateBlock) {
		t8 = (actionId, blockId, renderScopeId, trigger) => {
			return dispatchActionWithDeps(actionId, {
				block: repo.block(blockId),
				uiStateBlock,
				scopeRootId: topLevelBlockId,
				scopeRootForcesOpen: true,
				renderScopeId
			}, trigger);
		};
		$[10] = repo;
		$[11] = topLevelBlockId;
		$[12] = uiStateBlock;
		$[13] = t8;
	} else t8 = $[13];
	const runBlockAction = t8;
	let t9;
	if ($[14] !== runtime) {
		t9 = runtime.read(quickActionItemsFacet);
		$[14] = runtime;
		$[15] = t9;
	} else t9 = $[15];
	const actionItems = t9;
	let t10;
	if ($[16] !== actionItems || $[17] !== activeBlockId || $[18] !== activeRenderScopeId || $[19] !== allActions || $[20] !== previewBlockId || $[21] !== previewRenderScopeId || $[22] !== repo || $[23] !== topLevelBlockId || $[24] !== uiStateBlock) {
		bb0: {
			const blockId_0 = activeBlockId ?? previewBlockId;
			const renderScopeId_0 = activeBlockId ? activeRenderScopeId : previewRenderScopeId;
			if (!blockId_0) {
				t10 = actionItems;
				break bb0;
			}
			const block_0 = repo.block(blockId_0);
			if (!block_0.peek()) {
				t10 = actionItems;
				break bb0;
			}
			const deps_0 = {
				block: block_0,
				uiStateBlock,
				scopeRootId: topLevelBlockId,
				...renderScopeId_0 ? { renderScopeId: renderScopeId_0 } : {}
			};
			t10 = actionItems.filter((item) => {
				const action = allActions.find((a) => a.id === item.actionId);
				if (!action) return true;
				if (!action.isVisible) return true;
				return action.isVisible(deps_0);
			});
		}
		$[16] = actionItems;
		$[17] = activeBlockId;
		$[18] = activeRenderScopeId;
		$[19] = allActions;
		$[20] = previewBlockId;
		$[21] = previewRenderScopeId;
		$[22] = repo;
		$[23] = topLevelBlockId;
		$[24] = uiStateBlock;
		$[25] = t10;
	} else t10 = $[25];
	const visibleItems = t10;
	let t11;
	if ($[26] !== visibleItems) {
		const rows = /* @__PURE__ */ new Map();
		const overflow = [];
		for (const item_0 of visibleItems) if (item_0.overflow) overflow.push(item_0);
		else {
			const row = item_0.row ?? 1;
			const existing = rows.get(row);
			if (existing) existing.push(item_0);
			else rows.set(row, [item_0]);
		}
		t11 = [[...rows.entries()].sort(_temp).map(_temp2), overflow];
		$[26] = visibleItems;
		$[27] = t11;
	} else t11 = $[27];
	const [primaryRows, overflowItems] = t11;
	let t12;
	if ($[28] !== allActions || $[29] !== primaryRows) {
		let t13;
		if ($[31] !== allActions) {
			t13 = (items_0) => resolveActions(items_0, allActions);
			$[31] = allActions;
			$[32] = t13;
		} else t13 = $[32];
		t12 = primaryRows.map(t13);
		$[28] = allActions;
		$[29] = primaryRows;
		$[30] = t12;
	} else t12 = $[30];
	const primaryRowsResolved = t12;
	let t13;
	if ($[33] !== allActions || $[34] !== overflowItems) {
		t13 = resolveActions(overflowItems, allActions);
		$[33] = allActions;
		$[34] = overflowItems;
		$[35] = t13;
	} else t13 = $[35];
	const overflowResolved = t13;
	let t14;
	if ($[36] !== activeBlockId || $[37] !== activeRenderScopeId) {
		t14 = swipeTargetKey(activeBlockId, activeRenderScopeId);
		$[36] = activeBlockId;
		$[37] = activeRenderScopeId;
		$[38] = t14;
	} else t14 = $[38];
	const activeTargetKey = t14;
	const [trackedActiveTargetKey, setTrackedActiveTargetKey] = useState(activeTargetKey);
	if (trackedActiveTargetKey !== activeTargetKey) {
		setTrackedActiveTargetKey(activeTargetKey);
		if (showOverflow) setShowOverflow(false);
	}
	const [trackedTopLevelBlockId, setTrackedTopLevelBlockId] = useState(topLevelBlockId);
	if (trackedTopLevelBlockId !== topLevelBlockId) {
		setTrackedTopLevelBlockId(topLevelBlockId);
		if (activeBlockId) setActiveBlockId(void 0);
		if (activeRenderScopeId) setActiveRenderScopeId(void 0);
		if (previewBlockId !== null) setPreviewBlockId(null);
		if (previewRenderScopeId) setPreviewRenderScopeId(void 0);
		if (dragOffsetPercent !== null) setDragOffsetPercent(null);
		if (isSettling) setIsSettling(false);
	}
	let t15;
	let t16;
	if ($[39] !== activeBlockId || $[40] !== activeRenderScopeId || $[41] !== dragOffsetPercent || $[42] !== panelRoot || $[43] !== previewBlockId || $[44] !== previewRenderScopeId || $[45] !== runBlockAction) {
		t15 = () => {
			if (!panelRoot) return;
			const handleOpen = (event) => {
				if (!isSwipeQuickActionMenuEvent(event)) return;
				event.preventDefault();
				const { blockId: blockId_1, renderScopeId: renderScopeId_1 } = event.detail;
				setActiveBlockId(blockId_1);
				setActiveRenderScopeId(renderScopeId_1);
				if (sameSwipeTarget(previewBlockId, previewRenderScopeId, blockId_1, renderScopeId_1) && dragOffsetPercent !== null) startSettle("open");
				else {
					clearSettleTimer();
					setPreviewBlockId(null);
					setPreviewRenderScopeId(void 0);
					setDragOffsetPercent(null);
					setIsSettling(false);
				}
			};
			const handleClose = (event_0) => {
				if (!isSwipeQuickActionMenuEvent(event_0)) return;
				if (!sameSwipeTarget(event_0.detail.blockId, event_0.detail.renderScopeId, activeBlockId, activeRenderScopeId)) return;
				event_0.preventDefault();
				startSettle("closed");
			};
			const handleRun = (event_1) => {
				if (!isSwipeQuickActionRunEvent(event_1)) return;
				if (!runBlockAction(event_1.detail.actionId, event_1.detail.blockId, event_1.detail.renderScopeId, event_1)) return;
				event_1.preventDefault();
			};
			const handleProgress = (event_2) => {
				if (!isSwipeQuickActionProgressEvent(event_2)) return;
				const { blockId: blockId_2, renderScopeId: renderScopeId_2, dx, phase } = event_2.detail;
				if (phase === "active") {
					clearSettleTimer();
					setIsSettling(false);
					setPreviewBlockId(blockId_2);
					setPreviewRenderScopeId(renderScopeId_2);
					setDragOffsetPercent(computeOpenHidePercent(dx));
				} else if (phase === "cancel" && sameSwipeTarget(previewBlockId, previewRenderScopeId, blockId_2, renderScopeId_2)) startSettle("closed");
			};
			panelRoot.addEventListener(SWIPE_QUICK_ACTION_OPEN_EVENT, handleOpen);
			panelRoot.addEventListener(SWIPE_QUICK_ACTION_CLOSE_EVENT, handleClose);
			panelRoot.addEventListener(SWIPE_QUICK_ACTION_RUN_EVENT, handleRun);
			panelRoot.addEventListener(SWIPE_QUICK_ACTION_PROGRESS_EVENT, handleProgress);
			return () => {
				panelRoot.removeEventListener(SWIPE_QUICK_ACTION_OPEN_EVENT, handleOpen);
				panelRoot.removeEventListener(SWIPE_QUICK_ACTION_CLOSE_EVENT, handleClose);
				panelRoot.removeEventListener(SWIPE_QUICK_ACTION_RUN_EVENT, handleRun);
				panelRoot.removeEventListener(SWIPE_QUICK_ACTION_PROGRESS_EVENT, handleProgress);
			};
		};
		t16 = [
			activeBlockId,
			activeRenderScopeId,
			dragOffsetPercent,
			panelRoot,
			previewBlockId,
			previewRenderScopeId,
			runBlockAction,
			startSettle,
			clearSettleTimer
		];
		$[39] = activeBlockId;
		$[40] = activeRenderScopeId;
		$[41] = dragOffsetPercent;
		$[42] = panelRoot;
		$[43] = previewBlockId;
		$[44] = previewRenderScopeId;
		$[45] = runBlockAction;
		$[46] = t15;
		$[47] = t16;
	} else {
		t15 = $[46];
		t16 = $[47];
	}
	useEffect(t15, t16);
	let t17;
	let t18;
	if ($[48] !== activeBlockId || $[49] !== activeRenderScopeId || $[50] !== isMobile || $[51] !== panelRoot || $[52] !== repo) {
		t17 = () => {
			if (!activeBlockId || !isMobile || !panelRoot) return;
			const id = window.setTimeout(() => {
				const anchorElement = findSwipeActionBlockElement(panelRoot, activeBlockId, activeRenderScopeId);
				const block_1 = repo.block(activeBlockId);
				if (!anchorElement || !block_1.peek()) dismiss();
			}, 0);
			return () => window.clearTimeout(id);
		};
		t18 = [
			activeBlockId,
			activeRenderScopeId,
			dismiss,
			isMobile,
			panelRoot,
			repo
		];
		$[48] = activeBlockId;
		$[49] = activeRenderScopeId;
		$[50] = isMobile;
		$[51] = panelRoot;
		$[52] = repo;
		$[53] = t17;
		$[54] = t18;
	} else {
		t17 = $[53];
		t18 = $[54];
	}
	useEffect(t17, t18);
	let t19;
	let t20;
	if ($[55] !== activeBlockId) {
		t19 = () => {
			if (!activeBlockId) return;
			const handlePointer = (event_3) => {
				const target_0 = event_3.target;
				if (target_0 && containerRef.current?.contains(target_0)) return;
				dismiss();
			};
			const id_0 = window.setTimeout(() => {
				document.addEventListener("pointerdown", handlePointer, true);
			}, 0);
			return () => {
				window.clearTimeout(id_0);
				document.removeEventListener("pointerdown", handlePointer, true);
			};
		};
		t20 = [activeBlockId, dismiss];
		$[55] = activeBlockId;
		$[56] = t19;
		$[57] = t20;
	} else {
		t19 = $[56];
		t20 = $[57];
	}
	useEffect(t19, t20);
	let t21;
	let t22;
	if ($[58] !== activeBlockId) {
		t21 = () => {
			if (!activeBlockId) return;
			const handleKey = (event_4) => {
				if (event_4.key === "Escape") dismiss();
			};
			document.addEventListener("keydown", handleKey);
			return () => document.removeEventListener("keydown", handleKey);
		};
		t22 = [activeBlockId, dismiss];
		$[58] = activeBlockId;
		$[59] = t21;
		$[60] = t22;
	} else {
		t21 = $[59];
		t22 = $[60];
	}
	useEffect(t21, t22);
	let t23;
	if ($[61] === Symbol.for("react.memo_cache_sentinel")) {
		t23 = /* @__PURE__ */ jsx("div", {
			ref: inlineAnchorRef,
			className: "swipe-action-menu-anchor",
			"aria-hidden": "true"
		});
		$[61] = t23;
	} else t23 = $[61];
	const inlineAnchor = t23;
	const renderedBlockId = activeBlockId ?? previewBlockId;
	const renderedRenderScopeId = activeBlockId ? activeRenderScopeId : previewRenderScopeId;
	if (!isMobile || !renderedBlockId || !anchor) return inlineAnchor;
	let t24;
	let t25;
	let t26;
	let t27;
	let t28;
	let t29;
	let t30;
	let t31;
	let t32;
	let t33;
	let t34;
	let t35;
	let t36;
	if ($[62] !== activeBlockId || $[63] !== anchor || $[64] !== dragOffsetPercent || $[65] !== isSettling || $[66] !== overflowResolved || $[67] !== primaryRowsResolved || $[68] !== renderedBlockId || $[69] !== renderedRenderScopeId || $[70] !== repo || $[71] !== runBlockAction || $[72] !== showOverflow) {
		t36 = Symbol.for("react.early_return_sentinel");
		bb1: {
			const block_2 = repo.block(renderedBlockId);
			if (!block_2.peek()) {
				t36 = inlineAnchor;
				break bb1;
			}
			const handleRun_0 = (resolved) => {
				const { item: item_1, action: action_0 } = resolved;
				if (!action_0) {
					console.error(`[swipe-quick-actions] Action "${item_1.actionId}" not registered`);
					dismiss();
					return;
				}
				const trigger_0 = new CustomEvent("swipe-quick-action", { detail: renderedRenderScopeId ? {
					actionId: item_1.actionId,
					blockId: block_2.id,
					renderScopeId: renderedRenderScopeId
				} : {
					actionId: item_1.actionId,
					blockId: block_2.id
				} });
				runBlockAction(item_1.actionId, block_2.id, renderedRenderScopeId, trigger_0);
				dismiss();
			};
			let t37;
			if ($[86] === Symbol.for("react.memo_cache_sentinel")) {
				t37 = (event_5) => {
					const start = menuTouchStartRef.current;
					if (!start) return null;
					for (let i = 0; i < event_5.changedTouches.length; i++) {
						const touch = event_5.changedTouches[i];
						if (touch.identifier === start.identifier) return touch;
					}
					return null;
				};
				$[86] = t37;
			} else t37 = $[86];
			const trackedMenuTouch = t37;
			let t38;
			if ($[87] === Symbol.for("react.memo_cache_sentinel")) {
				t38 = (event_6) => {
					event_6.stopPropagation();
					const touch_0 = event_6.changedTouches[0];
					if (!touch_0) return;
					menuTouchStartRef.current = {
						x: touch_0.clientX,
						y: touch_0.clientY,
						identifier: touch_0.identifier
					};
				};
				$[87] = t38;
			} else t38 = $[87];
			const handleMenuTouchStart = t38;
			let t39;
			if ($[88] === Symbol.for("react.memo_cache_sentinel")) {
				t39 = (event_7) => {
					event_7.stopPropagation();
					const touch_1 = trackedMenuTouch(event_7);
					const start_0 = menuTouchStartRef.current;
					if (!touch_1 || !start_0) return;
					const dx_0 = touch_1.clientX - start_0.x;
					const dy = touch_1.clientY - start_0.y;
					if (dx_0 > 0 && Math.abs(dx_0) > Math.abs(dy)) {
						clearSettleTimer();
						setIsSettling(false);
						setDragOffsetPercent(computeCloseHidePercent(dx_0));
					}
				};
				$[88] = t39;
			} else t39 = $[88];
			const handleMenuTouchMove = t39;
			let t40;
			if ($[89] !== dragOffsetPercent) {
				t40 = (event_8) => {
					event_8.stopPropagation();
					const touch_2 = trackedMenuTouch(event_8);
					const start_1 = menuTouchStartRef.current;
					if (!touch_2 || !start_1) return;
					menuTouchStartRef.current = null;
					const dx_1 = touch_2.clientX - start_1.x;
					const dy_0 = touch_2.clientY - start_1.y;
					if (dx_1 >= 50 && Math.abs(dx_1) > Math.abs(dy_0)) {
						event_8.preventDefault();
						startSettle("closed");
					} else if (dragOffsetPercent !== null) startSettle("open");
				};
				$[89] = dragOffsetPercent;
				$[90] = t40;
			} else t40 = $[90];
			const handleMenuTouchEnd = t40;
			let t41;
			if ($[91] !== dragOffsetPercent) {
				t41 = (event_9) => {
					event_9.stopPropagation();
					if (trackedMenuTouch(event_9)) {
						menuTouchStartRef.current = null;
						if (dragOffsetPercent !== null) startSettle("open");
					}
				};
				$[91] = dragOffsetPercent;
				$[92] = t41;
			} else t41 = $[92];
			const handleMenuTouchCancel = t41;
			const toolbarHeight = Math.max(primaryRowsResolved.length, 1) * TOOLBAR_ROW_HEIGHT_PX;
			const centerY = anchor.top + anchor.height / 2;
			const toolbarTop = Math.min(Math.max(centerY, toolbarHeight / 2), window.innerHeight - toolbarHeight / 2);
			const toolbarTransform = `translate(${dragOffsetPercent ?? (activeBlockId ? 0 : 100)}%, -50%)`;
			const toolbarTransition = isSettling ? `transform ${SETTLE_DURATION_MS}ms ease-out` : void 0;
			t35 = inlineAnchor;
			t34 = createPortal;
			t24 = containerRef;
			t25 = "swipe-action-menu fixed left-0 right-0 z-50";
			const t42 = `${toolbarTop}px`;
			const t43 = dragOffsetPercent !== null ? "transform" : void 0;
			if ($[93] !== t42 || $[94] !== t43 || $[95] !== toolbarTransform || $[96] !== toolbarTransition) {
				t26 = {
					top: t42,
					transform: toolbarTransform,
					transition: toolbarTransition,
					willChange: t43
				};
				$[93] = t42;
				$[94] = t43;
				$[95] = toolbarTransform;
				$[96] = toolbarTransition;
				$[97] = t26;
			} else t26 = $[97];
			t27 = "ignore";
			t28 = handleMenuTouchStart;
			t29 = handleMenuTouchMove;
			t30 = handleMenuTouchEnd;
			t31 = handleMenuTouchCancel;
			const t44 = primaryRowsResolved.map((rowResolved, rowIndex) => /* @__PURE__ */ jsxs("div", {
				className: `flex h-7 items-center justify-around px-4 ${rowIndex > 0 ? "border-t border-border/80" : ""}`,
				children: [rowResolved.map((resolved_0) => /* @__PURE__ */ jsx(ActionButton, {
					resolved: resolved_0,
					onRun: handleRun_0
				}, resolved_0.item.actionId)), rowIndex === 0 && overflowResolved.length > 0 && /* @__PURE__ */ jsx("button", {
					type: "button",
					"aria-label": "More actions",
					title: "More actions",
					"aria-expanded": showOverflow,
					"data-block-interaction": "ignore",
					onClick: (event_10) => {
						event_10.preventDefault();
						event_10.stopPropagation();
						setShowOverflow(_temp3);
					},
					className: "flex h-7 w-7 items-center justify-center rounded text-foreground hover:bg-muted active:bg-accent",
					children: /* @__PURE__ */ jsx(Ellipsis, { className: "h-4 w-4" })
				})]
			}, `row-${rowIndex}`));
			if ($[98] !== t44) {
				t32 = /* @__PURE__ */ jsx("div", {
					className: "w-full border-y border-border bg-background/95 shadow-sm backdrop-blur supports-[backdrop-filter]:bg-background/85",
					children: t44
				});
				$[98] = t44;
				$[99] = t32;
			} else t32 = $[99];
			t33 = showOverflow && overflowResolved.length > 0 && /* @__PURE__ */ jsx("div", {
				className: "absolute right-2 top-full mt-1 flex flex-col gap-0.5 rounded-md border border-border bg-background/95 p-0.5 shadow-md backdrop-blur supports-[backdrop-filter]:bg-background/85",
				children: overflowResolved.map((resolved_1) => {
					const { Icon, label, item: item_2 } = resolved_1;
					return /* @__PURE__ */ jsxs("button", {
						type: "button",
						"aria-label": label,
						"data-block-interaction": "ignore",
						onClick: (event_11) => {
							event_11.preventDefault();
							event_11.stopPropagation();
							handleRun_0(resolved_1);
						},
						className: "flex items-center gap-2 rounded-md px-2 py-2 text-sm text-foreground hover:bg-muted active:bg-accent",
						children: [Icon && /* @__PURE__ */ jsx(Icon, { className: "h-4 w-4" }), /* @__PURE__ */ jsx("span", { children: label })]
					}, item_2.actionId);
				})
			});
		}
		$[62] = activeBlockId;
		$[63] = anchor;
		$[64] = dragOffsetPercent;
		$[65] = isSettling;
		$[66] = overflowResolved;
		$[67] = primaryRowsResolved;
		$[68] = renderedBlockId;
		$[69] = renderedRenderScopeId;
		$[70] = repo;
		$[71] = runBlockAction;
		$[72] = showOverflow;
		$[73] = t24;
		$[74] = t25;
		$[75] = t26;
		$[76] = t27;
		$[77] = t28;
		$[78] = t29;
		$[79] = t30;
		$[80] = t31;
		$[81] = t32;
		$[82] = t33;
		$[83] = t34;
		$[84] = t35;
		$[85] = t36;
	} else {
		t24 = $[73];
		t25 = $[74];
		t26 = $[75];
		t27 = $[76];
		t28 = $[77];
		t29 = $[78];
		t30 = $[79];
		t31 = $[80];
		t32 = $[81];
		t33 = $[82];
		t34 = $[83];
		t35 = $[84];
		t36 = $[85];
	}
	if (t36 !== Symbol.for("react.early_return_sentinel")) return t36;
	let t37;
	if ($[100] !== t24 || $[101] !== t25 || $[102] !== t26 || $[103] !== t27 || $[104] !== t28 || $[105] !== t29 || $[106] !== t30 || $[107] !== t31 || $[108] !== t32 || $[109] !== t33) {
		t37 = /* @__PURE__ */ jsxs("div", {
			ref: t24,
			className: t25,
			style: t26,
			"data-block-interaction": t27,
			onTouchStart: t28,
			onTouchMove: t29,
			onTouchEnd: t30,
			onTouchCancel: t31,
			children: [t32, t33]
		});
		$[100] = t24;
		$[101] = t25;
		$[102] = t26;
		$[103] = t27;
		$[104] = t28;
		$[105] = t29;
		$[106] = t30;
		$[107] = t31;
		$[108] = t32;
		$[109] = t33;
		$[110] = t37;
	} else t37 = $[110];
	let t38;
	if ($[111] !== t34 || $[112] !== t37) {
		t38 = t34(t37, document.body);
		$[111] = t34;
		$[112] = t37;
		$[113] = t38;
	} else t38 = $[113];
	let t39;
	if ($[114] !== t35 || $[115] !== t38) {
		t39 = /* @__PURE__ */ jsxs(Fragment$1, { children: [t35, t38] });
		$[114] = t35;
		$[115] = t38;
		$[116] = t39;
	} else t39 = $[116];
	return t39;
};
function _temp(a_0, b) {
	return a_0[0] - b[0];
}
function _temp2(t0) {
	const [, items] = t0;
	return items;
}
function _temp3(prev) {
	return !prev;
}
//#endregion
export { SwipeActionMenu };

//# sourceMappingURL=SwipeActionMenu.js.map