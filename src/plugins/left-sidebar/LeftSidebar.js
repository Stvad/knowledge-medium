import { aliasesProp } from "../../data/properties.js";
import { useRepo } from "../../context/repo.js";
import { useChildren, useHandle } from "../../hooks/block.js";
import { useAppRuntime } from "../../extensions/runtimeContext.js";
import { ArrowLeft } from "../../../node_modules/lucide-react/dist/esm/icons/arrow-left.js";
import { ChevronRight } from "../../../node_modules/lucide-react/dist/esm/icons/chevron-right.js";
import { useActiveContextsState } from "../../shortcuts/ActiveContexts.js";
import { useUserBlock } from "../../data/globalState.js";
import { useBlockOpener } from "../../utils/navigation.js";
import { ExtensionRenderBoundary } from "../../extensions/ExtensionRenderBoundary.js";
import { getEffectiveActions } from "../../shortcuts/effectiveActions.js";
import { useRunAction } from "../../shortcuts/runAction.js";
import { CREATE_NODE_IN_ACTIVE_PANEL_ACTION_ID } from "../../shortcuts/defaultShortcuts.js";
import { OPEN_TODAY_ACTION_ID } from "../daily-notes/actions.js";
import "../daily-notes/index.js";
import { QUICK_FIND_ACTION_ID } from "../quick-find/index.js";
import { leftSidebarToggle } from "./toggleStore.js";
import { leftSidebarSectionsFacet } from "./facet.js";
import { getOrCreateShortcutsBlock } from "./shortcuts.js";
import { Suspense, use, useEffect, useSyncExternalStore } from "react";
import { c } from "react/compiler-runtime";
import { Fragment as Fragment$1, jsx, jsxs } from "react/jsx-runtime";
//#region src/plugins/left-sidebar/LeftSidebar.tsx
var decodeAliases = (data) => {
	const raw = data.properties[aliasesProp.name];
	if (raw === void 0) return [];
	try {
		return aliasesProp.codec.decode(raw);
	} catch {
		return [];
	}
};
var blockLabel = (data, fallback) => {
	return (data ? data.aliases[0] ?? data.content : fallback).trim() || fallback || "Untitled";
};
function useShortcutsBlock() {
	const $ = c(2);
	const t0 = useUserBlock();
	let t1;
	if ($[0] !== t0) {
		t1 = getOrCreateShortcutsBlock(t0);
		$[0] = t0;
		$[1] = t1;
	} else t1 = $[1];
	return use(t1);
}
var LEFT_SIDEBAR_ACTION_EVENT = "left-sidebar-action";
function useRegisteredAction(actionId) {
	const $ = c(5);
	const runtime = useAppRuntime();
	let t0;
	if ($[0] !== actionId || $[1] !== runtime) {
		let t1;
		if ($[3] !== actionId) {
			t1 = (action) => action.id === actionId;
			$[3] = actionId;
			$[4] = t1;
		} else t1 = $[4];
		t0 = getEffectiveActions(runtime).find(t1);
		$[0] = actionId;
		$[1] = runtime;
		$[2] = t0;
	} else t0 = $[2];
	return t0;
}
function useSidebarActionRunner(t0) {
	const $ = c(12);
	const { actionId, closeSidebar } = t0;
	const action = useRegisteredAction(actionId);
	const activeContexts = useActiveContextsState();
	const runAction = useRunAction();
	const Icon = action?.icon;
	let t1;
	if ($[0] !== action || $[1] !== closeSidebar || $[2] !== runAction) {
		t1 = () => {
			if (!action) return;
			closeSidebar();
			runAction(action.id, new CustomEvent(LEFT_SIDEBAR_ACTION_EVENT, { detail: { actionId: action.id } }));
		};
		$[0] = action;
		$[1] = closeSidebar;
		$[2] = runAction;
		$[3] = t1;
	} else t1 = $[3];
	const run = t1;
	let t2;
	if ($[4] !== action || $[5] !== activeContexts) {
		t2 = !action || !activeContexts.has(action.context);
		$[4] = action;
		$[5] = activeContexts;
		$[6] = t2;
	} else t2 = $[6];
	let t3;
	if ($[7] !== Icon || $[8] !== action || $[9] !== run || $[10] !== t2) {
		t3 = {
			action,
			disabled: t2,
			Icon,
			run
		};
		$[7] = Icon;
		$[8] = action;
		$[9] = run;
		$[10] = t2;
		$[11] = t3;
	} else t3 = $[11];
	return t3;
}
function SidebarAction(t0) {
	const $ = c(12);
	const { actionId, closeSidebar, label } = t0;
	let t1;
	if ($[0] !== actionId || $[1] !== closeSidebar) {
		t1 = {
			actionId,
			closeSidebar
		};
		$[0] = actionId;
		$[1] = closeSidebar;
		$[2] = t1;
	} else t1 = $[2];
	const { action, disabled, Icon, run } = useSidebarActionRunner(t1);
	if (!action || !Icon) return null;
	let t2;
	if ($[3] !== Icon) {
		t2 = /* @__PURE__ */ jsx(Icon, { className: "h-5 w-5 shrink-0 text-muted-foreground" });
		$[3] = Icon;
		$[4] = t2;
	} else t2 = $[4];
	const t3 = label ?? action.description;
	let t4;
	if ($[5] !== t3) {
		t4 = /* @__PURE__ */ jsx("span", {
			className: "min-w-0 truncate",
			children: t3
		});
		$[5] = t3;
		$[6] = t4;
	} else t4 = $[6];
	let t5;
	if ($[7] !== disabled || $[8] !== run || $[9] !== t2 || $[10] !== t4) {
		t5 = /* @__PURE__ */ jsxs("button", {
			type: "button",
			className: "flex h-11 w-full items-center gap-3 rounded-md px-2 text-left text-sm text-foreground transition-colors hover:bg-accent disabled:pointer-events-none disabled:opacity-40",
			onClick: run,
			disabled,
			children: [t2, t4]
		});
		$[7] = disabled;
		$[8] = run;
		$[9] = t2;
		$[10] = t4;
		$[11] = t5;
	} else t5 = $[11];
	return t5;
}
function SearchSidebarAction(t0) {
	const $ = c(9);
	const { closeSidebar } = t0;
	let t1;
	if ($[0] !== closeSidebar) {
		t1 = {
			actionId: QUICK_FIND_ACTION_ID,
			closeSidebar
		};
		$[0] = closeSidebar;
		$[1] = t1;
	} else t1 = $[1];
	const { action, disabled, Icon, run } = useSidebarActionRunner(t1);
	if (!action || !Icon) return null;
	let t2;
	if ($[2] !== Icon) {
		t2 = /* @__PURE__ */ jsx(Icon, { className: "h-5 w-5 shrink-0" });
		$[2] = Icon;
		$[3] = t2;
	} else t2 = $[3];
	let t3;
	if ($[4] === Symbol.for("react.memo_cache_sentinel")) {
		t3 = /* @__PURE__ */ jsx("span", { children: "Jump to..." });
		$[4] = t3;
	} else t3 = $[4];
	let t4;
	if ($[5] !== disabled || $[6] !== run || $[7] !== t2) {
		t4 = /* @__PURE__ */ jsxs("button", {
			type: "button",
			className: "flex h-12 w-full items-center gap-3 rounded-full border border-border px-4 text-left text-sm text-muted-foreground shadow-sm transition-colors hover:bg-accent hover:text-foreground disabled:pointer-events-none disabled:opacity-40",
			onClick: run,
			disabled,
			children: [t2, t3]
		});
		$[5] = disabled;
		$[6] = run;
		$[7] = t2;
		$[8] = t4;
	} else t4 = $[8];
	return t4;
}
function LeftSidebarCoreSection(t0) {
	const $ = c(7);
	const { closeSidebar } = t0;
	let t1;
	if ($[0] !== closeSidebar) {
		t1 = /* @__PURE__ */ jsx(SearchSidebarAction, { closeSidebar });
		$[0] = closeSidebar;
		$[1] = t1;
	} else t1 = $[1];
	let t2;
	if ($[2] !== closeSidebar) {
		t2 = /* @__PURE__ */ jsx("div", {
			className: "space-y-1",
			children: /* @__PURE__ */ jsx(SidebarAction, {
				actionId: OPEN_TODAY_ACTION_ID,
				closeSidebar,
				label: "Today"
			})
		});
		$[2] = closeSidebar;
		$[3] = t2;
	} else t2 = $[3];
	let t3;
	if ($[4] !== t1 || $[5] !== t2) {
		t3 = /* @__PURE__ */ jsxs("section", {
			className: "space-y-5",
			children: [t1, t2]
		});
		$[4] = t1;
		$[5] = t2;
		$[6] = t3;
	} else t3 = $[6];
	return t3;
}
function ShortcutTargetItem(t0) {
	const $ = c(18);
	const { targetId, fallbackLabel, closeSidebar } = t0;
	const repo = useRepo();
	let t1;
	if ($[0] !== repo || $[1] !== targetId) {
		t1 = repo.block(targetId);
		$[0] = repo;
		$[1] = targetId;
		$[2] = t1;
	} else t1 = $[2];
	let t2;
	if ($[3] === Symbol.for("react.memo_cache_sentinel")) {
		t2 = { selector: _temp };
		$[3] = t2;
	} else t2 = $[3];
	const targetData = useHandle(t1, t2);
	let t3;
	if ($[4] !== fallbackLabel || $[5] !== targetData) {
		t3 = blockLabel(targetData, fallbackLabel);
		$[4] = fallbackLabel;
		$[5] = targetData;
		$[6] = t3;
	} else t3 = $[6];
	const label = t3;
	let t4;
	if ($[7] === Symbol.for("react.memo_cache_sentinel")) {
		t4 = { plainClick: "navigator" };
		$[7] = t4;
	} else t4 = $[7];
	const openBlock = useBlockOpener(t4);
	let t5;
	if ($[8] !== closeSidebar || $[9] !== openBlock || $[10] !== targetId) {
		t5 = (event) => {
			closeSidebar();
			openBlock(event, { blockId: targetId });
		};
		$[8] = closeSidebar;
		$[9] = openBlock;
		$[10] = targetId;
		$[11] = t5;
	} else t5 = $[11];
	const openShortcut = t5;
	let t6;
	if ($[12] === Symbol.for("react.memo_cache_sentinel")) {
		t6 = /* @__PURE__ */ jsx(ChevronRight, { className: "h-4 w-4 shrink-0 text-muted-foreground/70" });
		$[12] = t6;
	} else t6 = $[12];
	let t7;
	if ($[13] !== label) {
		t7 = /* @__PURE__ */ jsx("span", {
			className: "min-w-0 truncate",
			children: label
		});
		$[13] = label;
		$[14] = t7;
	} else t7 = $[14];
	let t8;
	if ($[15] !== openShortcut || $[16] !== t7) {
		t8 = /* @__PURE__ */ jsxs("button", {
			type: "button",
			className: "flex h-10 w-full items-center gap-2 rounded-md px-2 text-left text-sm text-muted-foreground transition-colors hover:bg-accent",
			onClick: openShortcut,
			children: [t6, t7]
		});
		$[15] = openShortcut;
		$[16] = t7;
		$[17] = t8;
	} else t8 = $[17];
	return t8;
}
function _temp(data) {
	return data ? {
		aliases: decodeAliases(data),
		content: data.content
	} : void 0;
}
function ShortcutItem(t0) {
	const $ = c(12);
	const { block, closeSidebar } = t0;
	let t1;
	if ($[0] === Symbol.for("react.memo_cache_sentinel")) {
		t1 = { selector: _temp2 };
		$[0] = t1;
	} else t1 = $[0];
	const data = useHandle(block, t1);
	if (!data) return null;
	let t2;
	if ($[1] !== data.references) {
		t2 = data.references.find(_temp3) ?? data.references[0];
		$[1] = data.references;
		$[2] = t2;
	} else t2 = $[2];
	const targetRef = t2;
	if (!targetRef) {
		let t3;
		if ($[3] === Symbol.for("react.memo_cache_sentinel")) {
			t3 = /* @__PURE__ */ jsx(ChevronRight, { className: "h-4 w-4 shrink-0 text-muted-foreground/40" });
			$[3] = t3;
		} else t3 = $[3];
		let t4;
		if ($[4] !== data) {
			t4 = blockLabel(data, "Unlinked shortcut");
			$[4] = data;
			$[5] = t4;
		} else t4 = $[5];
		let t5;
		if ($[6] !== t4) {
			t5 = /* @__PURE__ */ jsxs("div", {
				className: "flex h-10 items-center gap-2 px-2 text-sm text-muted-foreground/70",
				children: [t3, /* @__PURE__ */ jsx("span", {
					className: "min-w-0 truncate",
					children: t4
				})]
			});
			$[6] = t4;
			$[7] = t5;
		} else t5 = $[7];
		return t5;
	}
	let t3;
	if ($[8] !== closeSidebar || $[9] !== targetRef.alias || $[10] !== targetRef.id) {
		t3 = /* @__PURE__ */ jsx(ShortcutTargetItem, {
			targetId: targetRef.id,
			fallbackLabel: targetRef.alias,
			closeSidebar
		});
		$[8] = closeSidebar;
		$[9] = targetRef.alias;
		$[10] = targetRef.id;
		$[11] = t3;
	} else t3 = $[11];
	return t3;
}
function _temp3(ref) {
	return !ref.sourceField;
}
function _temp2(doc) {
	return doc ? {
		aliases: decodeAliases(doc),
		content: doc.content,
		references: doc.references
	} : void 0;
}
function LeftSidebarShortcutsSection(t0) {
	const $ = c(16);
	const { closeSidebar } = t0;
	const shortcutsBlock = useShortcutsBlock();
	const shortcuts = useChildren(shortcutsBlock);
	let t1;
	if ($[0] === Symbol.for("react.memo_cache_sentinel")) {
		t1 = { plainClick: "navigator" };
		$[0] = t1;
	} else t1 = $[0];
	const openBlock = useBlockOpener(t1);
	let t2;
	if ($[1] !== closeSidebar || $[2] !== openBlock || $[3] !== shortcutsBlock.id) {
		t2 = (event) => {
			closeSidebar();
			openBlock(event, { blockId: shortcutsBlock.id });
		};
		$[1] = closeSidebar;
		$[2] = openBlock;
		$[3] = shortcutsBlock.id;
		$[4] = t2;
	} else t2 = $[4];
	const openShortcutsBlock = t2;
	let t3;
	if ($[5] === Symbol.for("react.memo_cache_sentinel")) {
		t3 = /* @__PURE__ */ jsx("span", {
			className: "min-w-0 truncate",
			children: "Shortcuts"
		});
		$[5] = t3;
	} else t3 = $[5];
	let t4;
	if ($[6] !== openShortcutsBlock) {
		t4 = /* @__PURE__ */ jsx("button", {
			type: "button",
			className: "flex h-9 w-full items-center gap-2 rounded-md px-2 text-left text-sm font-medium text-foreground transition-colors hover:bg-accent",
			onClick: openShortcutsBlock,
			children: t3
		});
		$[6] = openShortcutsBlock;
		$[7] = t4;
	} else t4 = $[7];
	let t5;
	if ($[8] !== closeSidebar || $[9] !== shortcuts) {
		t5 = shortcuts.length === 0 ? /* @__PURE__ */ jsx("div", {
			className: "px-2 py-2 text-sm text-muted-foreground",
			children: "No shortcuts yet."
		}) : shortcuts.map((shortcut) => /* @__PURE__ */ jsx(ShortcutItem, {
			block: shortcut,
			closeSidebar
		}, shortcut.id));
		$[8] = closeSidebar;
		$[9] = shortcuts;
		$[10] = t5;
	} else t5 = $[10];
	let t6;
	if ($[11] !== t5) {
		t6 = /* @__PURE__ */ jsx("div", {
			className: "mt-1 space-y-0.5",
			children: t5
		});
		$[11] = t5;
		$[12] = t6;
	} else t6 = $[12];
	let t7;
	if ($[13] !== t4 || $[14] !== t6) {
		t7 = /* @__PURE__ */ jsxs("section", { children: [t4, t6] });
		$[13] = t4;
		$[14] = t6;
		$[15] = t7;
	} else t7 = $[15];
	return t7;
}
function NewNodeFooter(t0) {
	const $ = c(12);
	const { closeSidebar } = t0;
	let t1;
	if ($[0] !== closeSidebar) {
		t1 = {
			actionId: CREATE_NODE_IN_ACTIVE_PANEL_ACTION_ID,
			closeSidebar
		};
		$[0] = closeSidebar;
		$[1] = t1;
	} else t1 = $[1];
	const { action, disabled, Icon, run } = useSidebarActionRunner(t1);
	if (!action || !Icon) return null;
	let t2;
	if ($[2] === Symbol.for("react.memo_cache_sentinel")) {
		t2 = { paddingBottom: "calc(1rem + env(safe-area-inset-bottom))" };
		$[2] = t2;
	} else t2 = $[2];
	let t3;
	if ($[3] !== Icon) {
		t3 = /* @__PURE__ */ jsx(Icon, { className: "h-5 w-5" });
		$[3] = Icon;
		$[4] = t3;
	} else t3 = $[4];
	let t4;
	if ($[5] !== action.description) {
		t4 = /* @__PURE__ */ jsx("span", { children: action.description });
		$[5] = action.description;
		$[6] = t4;
	} else t4 = $[6];
	let t5;
	if ($[7] !== disabled || $[8] !== run || $[9] !== t3 || $[10] !== t4) {
		t5 = /* @__PURE__ */ jsx("div", {
			className: "shrink-0 border-t border-border px-5 pt-4",
			style: t2,
			children: /* @__PURE__ */ jsxs("button", {
				type: "button",
				className: "flex h-12 w-full items-center justify-center gap-2 rounded-full bg-muted px-4 text-sm font-medium text-foreground transition-colors hover:bg-accent disabled:pointer-events-none disabled:opacity-40",
				onClick: run,
				disabled,
				children: [t3, t4]
			})
		});
		$[7] = disabled;
		$[8] = run;
		$[9] = t3;
		$[10] = t4;
		$[11] = t5;
	} else t5 = $[11];
	return t5;
}
function NewNodeFooterFallback() {
	const $ = c(2);
	let t0;
	if ($[0] === Symbol.for("react.memo_cache_sentinel")) {
		t0 = { paddingBottom: "calc(1rem + env(safe-area-inset-bottom))" };
		$[0] = t0;
	} else t0 = $[0];
	let t1;
	if ($[1] === Symbol.for("react.memo_cache_sentinel")) {
		t1 = /* @__PURE__ */ jsx("div", {
			className: "shrink-0 border-t border-border px-5 pt-4",
			style: t0,
			"aria-label": "Loading sidebar footer",
			children: /* @__PURE__ */ jsx("div", { className: "h-12 w-full animate-pulse rounded-full bg-muted" })
		});
		$[1] = t1;
	} else t1 = $[1];
	return t1;
}
function SidebarSections(t0) {
	const $ = c(7);
	const { sections, closeSidebar } = t0;
	let t1;
	if ($[0] !== closeSidebar || $[1] !== sections) {
		let t2;
		if ($[3] !== closeSidebar) {
			t2 = (t3) => {
				const { id, component: Section } = t3;
				return /* @__PURE__ */ jsx(ExtensionRenderBoundary, {
					suspenseFallback: /* @__PURE__ */ jsx(SidebarSectionFallback, {}),
					children: /* @__PURE__ */ jsx(Section, { closeSidebar })
				}, id);
			};
			$[3] = closeSidebar;
			$[4] = t2;
		} else t2 = $[4];
		t1 = sections.map(t2);
		$[0] = closeSidebar;
		$[1] = sections;
		$[2] = t1;
	} else t1 = $[2];
	let t2;
	if ($[5] !== t1) {
		t2 = /* @__PURE__ */ jsx(Fragment$1, { children: t1 });
		$[5] = t1;
		$[6] = t2;
	} else t2 = $[6];
	return t2;
}
function SidebarSectionFallback() {
	const $ = c(1);
	let t0;
	if ($[0] === Symbol.for("react.memo_cache_sentinel")) {
		t0 = /* @__PURE__ */ jsxs("section", {
			className: "space-y-2 px-2 py-1",
			"aria-label": "Loading sidebar section",
			children: [
				/* @__PURE__ */ jsx("div", { className: "h-4 w-24 animate-pulse rounded bg-muted" }),
				/* @__PURE__ */ jsx("div", { className: "h-8 w-full animate-pulse rounded-md bg-muted/70" }),
				/* @__PURE__ */ jsx("div", { className: "h-8 w-3/4 animate-pulse rounded-md bg-muted/70" })
			]
		});
		$[0] = t0;
	} else t0 = $[0];
	return t0;
}
function LeftSidebar() {
	const $ = c(11);
	const runtime = useAppRuntime();
	let t0;
	if ($[0] !== runtime) {
		t0 = runtime.read(leftSidebarSectionsFacet);
		$[0] = runtime;
		$[1] = t0;
	} else t0 = $[1];
	const sections = t0;
	const open = useSyncExternalStore(leftSidebarToggle.subscribe, leftSidebarToggle.isOpen, leftSidebarToggle.isOpen);
	const closeSidebar = leftSidebarToggle.close;
	let t1;
	if ($[2] === Symbol.for("react.memo_cache_sentinel")) {
		t1 = [];
		$[2] = t1;
	} else t1 = $[2];
	useEffect(_temp5, t1);
	if (!open) return null;
	let t2;
	if ($[3] === Symbol.for("react.memo_cache_sentinel")) {
		t2 = /* @__PURE__ */ jsx("button", {
			type: "button",
			"aria-label": "Close sidebar",
			className: "absolute inset-0 cursor-default bg-background/10",
			onClick: closeSidebar
		});
		$[3] = t2;
	} else t2 = $[3];
	let t3;
	if ($[4] === Symbol.for("react.memo_cache_sentinel")) {
		t3 = { paddingTop: "env(safe-area-inset-top, 0px)" };
		$[4] = t3;
	} else t3 = $[4];
	let t4;
	if ($[5] === Symbol.for("react.memo_cache_sentinel")) {
		t4 = /* @__PURE__ */ jsx("div", {
			className: "flex h-14 shrink-0 items-center justify-end px-4",
			children: /* @__PURE__ */ jsx("button", {
				type: "button",
				className: "flex h-10 w-10 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground",
				onClick: closeSidebar,
				"aria-label": "Close sidebar",
				title: "Close",
				children: /* @__PURE__ */ jsx(ArrowLeft, { className: "h-5 w-5" })
			})
		});
		$[5] = t4;
	} else t4 = $[5];
	let t5;
	if ($[6] !== sections) {
		t5 = /* @__PURE__ */ jsx("div", {
			className: "flex min-h-0 flex-1 flex-col gap-6 overflow-y-auto px-5 pb-5",
			children: /* @__PURE__ */ jsx(SidebarSections, {
				sections,
				closeSidebar
			})
		});
		$[6] = sections;
		$[7] = t5;
	} else t5 = $[7];
	let t6;
	if ($[8] === Symbol.for("react.memo_cache_sentinel")) {
		t6 = /* @__PURE__ */ jsx(Suspense, {
			fallback: /* @__PURE__ */ jsx(NewNodeFooterFallback, {}),
			children: /* @__PURE__ */ jsx(NewNodeFooter, { closeSidebar })
		});
		$[8] = t6;
	} else t6 = $[8];
	let t7;
	if ($[9] !== t5) {
		t7 = /* @__PURE__ */ jsxs("div", {
			className: "fixed inset-0 z-50",
			"data-block-interaction": "ignore",
			children: [t2, /* @__PURE__ */ jsxs("aside", {
				role: "dialog",
				"aria-modal": "true",
				"aria-label": "Sidebar",
				style: t3,
				className: "absolute inset-y-0 left-0 flex w-[min(82vw,28rem)] max-w-full flex-col border-r border-border bg-background shadow-2xl md:w-80",
				children: [
					t4,
					t5,
					t6
				]
			})]
		});
		$[9] = t5;
		$[10] = t7;
	} else t7 = $[10];
	return t7;
}
function _temp5() {
	const handleKeyDown = _temp4;
	window.addEventListener("keydown", handleKeyDown);
	return () => window.removeEventListener("keydown", handleKeyDown);
}
function _temp4(event) {
	if (event.key === "Escape") leftSidebarToggle.close();
}
//#endregion
export { LeftSidebar, LeftSidebarCoreSection, LeftSidebarShortcutsSection };

//# sourceMappingURL=LeftSidebar.js.map