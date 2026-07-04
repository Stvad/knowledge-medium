import { outlineRenderScopeId } from "../../utils/renderScope.js";
import { peekFocusedBlockLocation, scrollTopProp, topLevelBlockIdProp } from "../../data/properties.js";
import { Button } from "../ui/button.js";
import { panelMountsFacet } from "../../extensions/core.js";
import { useRepo } from "../../context/repo.js";
import { usePropertyValue } from "../../hooks/block.js";
import { useAppRuntime } from "../../extensions/runtimeContext.js";
import { ChevronRight } from "../../../node_modules/lucide-react/dist/esm/icons/chevron-right.js";
import { ChevronLeft } from "../../../node_modules/lucide-react/dist/esm/icons/chevron-left.js";
import { X } from "../../../node_modules/lucide-react/dist/esm/icons/x.js";
import { ActionContextTypes } from "../../shortcuts/types.js";
import { NestedBlockContextProvider, useBlockContext } from "../../context/block.js";
import { useIsActivePanel, useSelectionState } from "../../data/globalState.js";
import { useActionContext } from "../../shortcuts/useActionContext.js";
import { goBackInPanel, goForwardInPanel, panelHistory, usePanelHistory } from "../../utils/panelHistory.js";
import { deletePanelRow } from "../../utils/panelLayoutProjection.js";
import { ExtensionRenderBoundary } from "../../extensions/ExtensionRenderBoundary.js";
import { BlockComponent } from "../BlockComponent.js";
import { useEffect, useRef } from "react";
import { c } from "react/compiler-runtime";
import { Fragment as Fragment$1, jsx, jsxs } from "react/jsx-runtime";
//#region src/components/renderer/PanelRenderer.tsx
var SCROLL_WRITE_DELAY_MS = 200;
var PANEL_ACTION_BUTTON_CLASS = "pointer-events-auto h-6 w-6 bg-background/60 text-muted-foreground hover:bg-accent hover:text-foreground";
var PANEL_HISTORY_BUTTON_CLASS = `${PANEL_ACTION_BUTTON_CLASS} disabled:text-muted-foreground/40 disabled:hover:bg-background/60 disabled:hover:text-muted-foreground/40`;
function PanelMultiSelectActionContext(t0) {
	const $ = c(12);
	const { scopeRootId } = t0;
	const [selectionState] = useSelectionState();
	const repo = useRepo();
	let t1;
	bb0: {
		if (!selectionState.selectedBlockIds.length) {
			t1 = null;
			break bb0;
		}
		let t2;
		if ($[0] !== repo || $[1] !== selectionState.selectedBlockIds) {
			let t3;
			if ($[3] !== repo) {
				t3 = (id) => repo.block(id);
				$[3] = repo;
				$[4] = t3;
			} else t3 = $[4];
			t2 = selectionState.selectedBlockIds.map(t3);
			$[0] = repo;
			$[1] = selectionState.selectedBlockIds;
			$[2] = t2;
		} else t2 = $[2];
		let t3;
		if ($[5] !== repo || $[6] !== selectionState.anchorBlockId) {
			t3 = selectionState.anchorBlockId ? repo.block(selectionState.anchorBlockId) : null;
			$[5] = repo;
			$[6] = selectionState.anchorBlockId;
			$[7] = t3;
		} else t3 = $[7];
		let t4;
		if ($[8] !== scopeRootId || $[9] !== t2 || $[10] !== t3) {
			t4 = {
				selectedBlocks: t2,
				anchorBlock: t3,
				scopeRootId
			};
			$[8] = scopeRootId;
			$[9] = t2;
			$[10] = t3;
			$[11] = t4;
		} else t4 = $[11];
		t1 = t4;
	}
	const multiSelectDeps = t1;
	useActionContext(ActionContextTypes.MULTI_SELECT_MODE, multiSelectDeps, Boolean(multiSelectDeps));
	return null;
}
function PanelRenderer(t0) {
	const $ = c(77);
	const { block } = t0;
	const [topLevelBlockId] = usePropertyValue(block, topLevelBlockIdProp);
	const blockContext = useBlockContext();
	const canClosePanel = Boolean(blockContext.canClosePanel);
	const stackedPanel = Boolean(blockContext.stackedPanel);
	const wideScrollSurface = Boolean(blockContext.wideScrollSurface) && !stackedPanel;
	const repo = useRepo();
	const isActivePanel = useIsActivePanel(block);
	const { canBack, canForward } = usePanelHistory(block.id);
	const runtime = useAppRuntime();
	let t1;
	if ($[0] !== runtime) {
		t1 = runtime.read(panelMountsFacet);
		$[0] = runtime;
		$[1] = t1;
	} else t1 = $[1];
	const panelMounts = t1;
	const scrollRef = useRef(null);
	const pendingScrollTopRef = useRef(void 0);
	const scrollWriteTimerRef = useRef(null);
	let t2;
	if ($[2] !== block) {
		t2 = () => {
			if (scrollWriteTimerRef.current) {
				clearTimeout(scrollWriteTimerRef.current);
				scrollWriteTimerRef.current = null;
			}
			const next = pendingScrollTopRef.current;
			pendingScrollTopRef.current = void 0;
			if (next === void 0) return;
			if (block.peekProperty(scrollTopProp) === next) return;
			block.set(scrollTopProp, next);
		};
		$[2] = block;
		$[3] = t2;
	} else t2 = $[3];
	const flushScrollTop = t2;
	let t3;
	if ($[4] !== flushScrollTop) {
		t3 = () => {
			const el = scrollRef.current;
			if (!el) return;
			pendingScrollTopRef.current = el.scrollTop;
			if (scrollWriteTimerRef.current) clearTimeout(scrollWriteTimerRef.current);
			scrollWriteTimerRef.current = setTimeout(flushScrollTop, SCROLL_WRITE_DELAY_MS);
		};
		$[4] = flushScrollTop;
		$[5] = t3;
	} else t3 = $[5];
	const scheduleScrollTopWrite = t3;
	let t4;
	let t5;
	if ($[6] !== block) {
		t4 = () => panelHistory.registerSnapshotter(block.id, () => ({
			focusedLocation: peekFocusedBlockLocation(block),
			scrollTop: scrollRef.current?.scrollTop
		}));
		t5 = [block];
		$[6] = block;
		$[7] = t4;
		$[8] = t5;
	} else {
		t4 = $[7];
		t5 = $[8];
	}
	useEffect(t4, t5);
	let t6;
	let t7;
	if ($[9] !== block || $[10] !== topLevelBlockId) {
		t6 = () => {
			if (!topLevelBlockId) return;
			const scrollTop = panelHistory.consumeRestore(block.id)?.scrollTop ?? block.peekProperty(scrollTopProp);
			if (scrollTop != null && scrollRef.current) scrollRef.current.scrollTop = scrollTop;
		};
		t7 = [topLevelBlockId, block];
		$[9] = block;
		$[10] = topLevelBlockId;
		$[11] = t6;
		$[12] = t7;
	} else {
		t6 = $[11];
		t7 = $[12];
	}
	useEffect(t6, t7);
	let t8;
	let t9;
	if ($[13] !== flushScrollTop) {
		t8 = () => flushScrollTop;
		t9 = [flushScrollTop];
		$[13] = flushScrollTop;
		$[14] = t8;
		$[15] = t9;
	} else {
		t8 = $[14];
		t9 = $[15];
	}
	useEffect(t8, t9);
	let t10;
	let t11;
	if ($[16] !== flushScrollTop) {
		t10 = () => {
			if (typeof document === "undefined") return;
			const handleVisibilityChange = () => {
				if (document.visibilityState === "hidden") flushScrollTop();
			};
			document.addEventListener("visibilitychange", handleVisibilityChange);
			return () => {
				document.removeEventListener("visibilitychange", handleVisibilityChange);
			};
		};
		t11 = [flushScrollTop];
		$[16] = flushScrollTop;
		$[17] = t10;
		$[18] = t11;
	} else {
		t10 = $[17];
		t11 = $[18];
	}
	useEffect(t10, t11);
	let t12;
	if ($[19] !== block.id || $[20] !== repo) {
		t12 = () => {
			deletePanelRow(repo, block.id);
		};
		$[19] = block.id;
		$[20] = repo;
		$[21] = t12;
	} else t12 = $[21];
	const handleClose = t12;
	if (!topLevelBlockId) {
		console.warn(`Panel ${block.id} has no topLevelBlockId, skipping render.`);
		return null;
	}
	let t13;
	if ($[22] !== block) {
		t13 = () => {
			goBackInPanel(block);
		};
		$[22] = block;
		$[23] = t13;
	} else t13 = $[23];
	const t14 = !canBack;
	let t15;
	if ($[24] === Symbol.for("react.memo_cache_sentinel")) {
		t15 = /* @__PURE__ */ jsx(ChevronLeft, { className: "h-4 w-4" });
		$[24] = t15;
	} else t15 = $[24];
	let t16;
	if ($[25] !== t13 || $[26] !== t14) {
		t16 = /* @__PURE__ */ jsx(Button, {
			variant: "ghost",
			size: "icon",
			className: PANEL_HISTORY_BUTTON_CLASS,
			onClick: t13,
			disabled: t14,
			"aria-label": "Back",
			title: "Back",
			children: t15
		});
		$[25] = t13;
		$[26] = t14;
		$[27] = t16;
	} else t16 = $[27];
	let t17;
	if ($[28] !== block) {
		t17 = () => {
			goForwardInPanel(block);
		};
		$[28] = block;
		$[29] = t17;
	} else t17 = $[29];
	const t18 = !canForward;
	let t19;
	if ($[30] === Symbol.for("react.memo_cache_sentinel")) {
		t19 = /* @__PURE__ */ jsx(ChevronRight, { className: "h-4 w-4" });
		$[30] = t19;
	} else t19 = $[30];
	let t20;
	if ($[31] !== t17 || $[32] !== t18) {
		t20 = /* @__PURE__ */ jsx(Button, {
			variant: "ghost",
			size: "icon",
			className: PANEL_HISTORY_BUTTON_CLASS,
			onClick: t17,
			disabled: t18,
			"aria-label": "Forward",
			title: "Forward",
			children: t19
		});
		$[31] = t17;
		$[32] = t18;
		$[33] = t20;
	} else t20 = $[33];
	let t21;
	if ($[34] !== canClosePanel || $[35] !== handleClose) {
		t21 = canClosePanel && /* @__PURE__ */ jsx(Button, {
			variant: "ghost",
			size: "icon",
			className: PANEL_ACTION_BUTTON_CLASS,
			onClick: handleClose,
			"aria-label": "Close panel",
			children: /* @__PURE__ */ jsx(X, { className: "h-4 w-4" })
		});
		$[34] = canClosePanel;
		$[35] = handleClose;
		$[36] = t21;
	} else t21 = $[36];
	let t22;
	if ($[37] !== t16 || $[38] !== t20 || $[39] !== t21) {
		t22 = /* @__PURE__ */ jsxs(Fragment$1, { children: [
			t16,
			t20,
			t21
		] });
		$[37] = t16;
		$[38] = t20;
		$[39] = t21;
		$[40] = t22;
	} else t22 = $[40];
	const actionButtons = t22;
	let t23;
	if ($[41] !== topLevelBlockId) {
		t23 = outlineRenderScopeId(topLevelBlockId);
		$[41] = topLevelBlockId;
		$[42] = t23;
	} else t23 = $[42];
	let t24;
	if ($[43] !== t23 || $[44] !== topLevelBlockId) {
		t24 = {
			layoutBoundary: false,
			renderScopeId: t23,
			scopeRootId: topLevelBlockId
		};
		$[43] = t23;
		$[44] = topLevelBlockId;
		$[45] = t24;
	} else t24 = $[45];
	let t25;
	if ($[46] !== topLevelBlockId) {
		t25 = /* @__PURE__ */ jsx(BlockComponent, { blockId: topLevelBlockId });
		$[46] = topLevelBlockId;
		$[47] = t25;
	} else t25 = $[47];
	let t26;
	if ($[48] !== t24 || $[49] !== t25) {
		t26 = /* @__PURE__ */ jsx(NestedBlockContextProvider, {
			overrides: t24,
			children: t25
		});
		$[48] = t24;
		$[49] = t25;
		$[50] = t26;
	} else t26 = $[50];
	const panelBody = t26;
	const t27 = block.id;
	const t28 = isActivePanel ? "true" : void 0;
	const t29 = `panel min-w-0 max-w-full flex flex-col relative ${stackedPanel ? "overflow-visible" : "h-full flex-grow overflow-hidden"} ${isActivePanel ? "panel-active" : ""}`;
	let t30;
	if ($[51] !== isActivePanel || $[52] !== topLevelBlockId) {
		t30 = isActivePanel && /* @__PURE__ */ jsx(PanelMultiSelectActionContext, { scopeRootId: topLevelBlockId });
		$[51] = isActivePanel;
		$[52] = topLevelBlockId;
		$[53] = t30;
	} else t30 = $[53];
	let t31;
	if ($[54] !== actionButtons || $[55] !== wideScrollSurface) {
		t31 = wideScrollSurface ? /* @__PURE__ */ jsx("div", {
			className: "pointer-events-none absolute inset-x-0 top-1 z-10",
			children: /* @__PURE__ */ jsx("div", {
				className: "pointer-events-none mx-auto flex w-full max-w-3xl justify-end gap-0.5",
				children: actionButtons
			})
		}) : /* @__PURE__ */ jsx("div", {
			className: "pointer-events-none absolute top-1 right-0.5 z-10 flex gap-0.5",
			children: actionButtons
		});
		$[54] = actionButtons;
		$[55] = wideScrollSurface;
		$[56] = t31;
	} else t31 = $[56];
	const t32 = stackedPanel ? "overflow-visible" : "flex-grow overflow-y-auto scrollbar-none pb-[calc(env(safe-area-inset-bottom)+4rem)] md:pb-0";
	let t33;
	if ($[57] !== panelBody || $[58] !== wideScrollSurface) {
		t33 = wideScrollSurface ? /* @__PURE__ */ jsx("div", {
			className: "mx-auto w-full max-w-3xl",
			children: panelBody
		}) : panelBody;
		$[57] = panelBody;
		$[58] = wideScrollSurface;
		$[59] = t33;
	} else t33 = $[59];
	let t34;
	if ($[60] !== scheduleScrollTopWrite || $[61] !== t32 || $[62] !== t33) {
		t34 = /* @__PURE__ */ jsx("div", {
			ref: scrollRef,
			className: t32,
			onScroll: scheduleScrollTopWrite,
			children: t33
		});
		$[60] = scheduleScrollTopWrite;
		$[61] = t32;
		$[62] = t33;
		$[63] = t34;
	} else t34 = $[63];
	let t35;
	if ($[64] !== block || $[65] !== panelMounts) {
		let t36;
		if ($[67] !== block) {
			t36 = (t37) => {
				const { id, component: Component } = t37;
				return /* @__PURE__ */ jsx(ExtensionRenderBoundary, { children: /* @__PURE__ */ jsx(Component, { block }) }, id);
			};
			$[67] = block;
			$[68] = t36;
		} else t36 = $[68];
		t35 = panelMounts.map(t36);
		$[64] = block;
		$[65] = panelMounts;
		$[66] = t35;
	} else t35 = $[66];
	let t36;
	if ($[69] !== block.id || $[70] !== t28 || $[71] !== t29 || $[72] !== t30 || $[73] !== t31 || $[74] !== t34 || $[75] !== t35) {
		t36 = /* @__PURE__ */ jsxs("div", {
			"data-panel-id": t27,
			"data-panel-active": t28,
			className: t29,
			children: [
				t30,
				t31,
				t34,
				t35
			]
		});
		$[69] = block.id;
		$[70] = t28;
		$[71] = t29;
		$[72] = t30;
		$[73] = t31;
		$[74] = t34;
		$[75] = t35;
		$[76] = t36;
	} else t36 = $[76];
	return t36;
}
PanelRenderer.canRender = ({ context }) => !!(context?.layoutBoundary && context.panelId);
PanelRenderer.priority = () => 5;
//#endregion
export { PanelRenderer };

//# sourceMappingURL=PanelRenderer.js.map