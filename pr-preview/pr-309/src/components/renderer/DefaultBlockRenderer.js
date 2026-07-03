import { m } from "../../../node_modules/react-error-boundary/dist/react-error-boundary.js";
import { isCollapsedProp, showPropertiesProp, topLevelBlockIdProp, typesProp } from "../../data/properties.js";
import { cn } from "../../lib/utils.js";
import { Button } from "../ui/button.js";
import { useRepo } from "../../context/repo.js";
import { useHasChildren, usePropertyValue } from "../../hooks/block.js";
import { useAppRuntime } from "../../extensions/runtimeContext.js";
import { useBlockContext } from "../../context/block.js";
import { buildAppHash } from "../../utils/routing.js";
import { useInEditMode, useIsSelected, useUIStateBlock, useUIStateProperty } from "../../data/globalState.js";
import { withMoveTransition } from "../../utils/viewTransition.js";
import { navigate, useOpenBlock } from "../../utils/navigation.js";
import { BlockProperties } from "../BlockProperties.js";
import { Collapsible, CollapsibleContent } from "../ui/collapsible.js";
import { MarkdownContentRenderer } from "./MarkdownContentRenderer.js";
import { blockChildrenFooterFacet, blockClickHandlersFacet, blockContentDecoratorsFacet, blockContentRendererFacet, blockContentSurfacePropsFacet, blockHeaderFacet, blockLayoutFacet, blockShellDecoratorsFacet } from "../../extensions/blockInteraction.js";
import { useShortcutSurfaceActivations } from "../../extensions/useShortcutSurfaceActivations.js";
import { CodeMirrorContentRenderer } from "./CodeMirrorContentRenderer.js";
import { useIsMobile } from "../../utils/react.js";
import { FallbackComponent } from "../util/error.js";
import { ContextMenu, ContextMenuContent, ContextMenuItem, ContextMenuPortal, ContextMenuSeparator, ContextMenuTrigger } from "../ui/context-menu.js";
import { useIsFocalRender } from "../../hooks/useIsFocalRender.js";
import { ExtensionRenderBoundary } from "../../extensions/ExtensionRenderBoundary.js";
import { useContinuousGestures } from "../../extensions/continuousGestures.js";
import { BlockChildren } from "../BlockComponent.js";
import { useMemo, useRef } from "react";
import { c } from "react/compiler-runtime";
import { Fragment as Fragment$1, jsx, jsxs } from "react/jsx-runtime";
//#region src/components/renderer/DefaultBlockRenderer.tsx
/** Todo plausibly the following 2 things should be "actions" too
* and would be nice to have the mechanism to invoke arbitrary action?
*   e.g. have a custom event like 'trigger-action' with appropriate deps
*
* but like it's context independent? so when we fire an action like that, it shouldn't matter if it's "active"
* bc we're providing deps?
*
* alternative interpretation is that we can just fire them by name and context, and then assume the deps are already there
*  - nvm, here we're not changing selected block, so if we rely on pre-filled deps, we'll end pu with incorrect id
*
*/
var copyBlockId = (block) => {
	navigator.clipboard.writeText(block.id);
};
var copyBlockRef = (block) => {
	navigator.clipboard.writeText(`((${block.id}))`);
};
var copyBlockEmbed = (block) => {
	navigator.clipboard.writeText(`!((${block.id}))`);
};
var zoomIn = (block, workspaceId, panelId) => {
	if (typeof window !== "undefined") navigate(block.repo, panelId ? {
		blockId: block.id,
		workspaceId,
		target: "panel",
		panelId
	} : {
		blockId: block.id,
		workspaceId,
		target: "active"
	});
};
/** Static bullet visual — pure markup, no link/menu/data dependency.
*  Exported so LazyBlockComponent can reuse the exact same dot in its
*  placeholder, keeping placeholder layout aligned with mounted blocks. */
function BulletDot(t0) {
	const $ = c(2);
	const { withChildrenIndicator: t1 } = t0;
	const t2 = "bullet h-1.5 w-1.5 rounded-full bg-muted-foreground/80 mx-auto" + ((t1 === void 0 ? false : t1) ? " bullet-with-children border-4 border-solid border-border box-content" : "");
	let t3;
	if ($[0] !== t2) {
		t3 = /* @__PURE__ */ jsx("span", { className: t2 });
		$[0] = t2;
		$[1] = t3;
	} else t3 = $[1];
	return t3;
}
var BlockBullet = (t0) => {
	const $ = c(38);
	const { block } = t0;
	const repo = useRepo();
	const { panelId } = useBlockContext();
	const [showProperties, setShowProperties] = usePropertyValue(block, showPropertiesProp);
	const [isCollapsed] = usePropertyValue(block, isCollapsedProp);
	const hasChildren = useHasChildren(block);
	const workspaceId = repo.activeWorkspaceId;
	let t1;
	if ($[0] !== block.id || $[1] !== workspaceId) {
		t1 = {
			blockId: block.id,
			workspaceId
		};
		$[0] = block.id;
		$[1] = workspaceId;
		$[2] = t1;
	} else t1 = $[2];
	const onClick = useOpenBlock(t1);
	let t2;
	if ($[3] !== block.id || $[4] !== workspaceId) {
		t2 = buildAppHash(workspaceId, block.id);
		$[3] = block.id;
		$[4] = workspaceId;
		$[5] = t2;
	} else t2 = $[5];
	const t3 = hasChildren && isCollapsed;
	let t4;
	if ($[6] !== t3) {
		t4 = /* @__PURE__ */ jsx(BulletDot, { withChildrenIndicator: t3 });
		$[6] = t3;
		$[7] = t4;
	} else t4 = $[7];
	let t5;
	if ($[8] !== onClick || $[9] !== t2 || $[10] !== t4) {
		t5 = /* @__PURE__ */ jsx(ContextMenuTrigger, {
			asChild: true,
			children: /* @__PURE__ */ jsx("a", {
				href: t2,
				className: "bullet-link flex items-center justify-center h-6 w-5",
				onClick,
				children: t4
			})
		});
		$[8] = onClick;
		$[9] = t2;
		$[10] = t4;
		$[11] = t5;
	} else t5 = $[11];
	let t6;
	if ($[12] !== block) {
		t6 = /* @__PURE__ */ jsx(ContextMenuItem, {
			className: "flex cursor-pointer items-center px-2 py-1.5 text-sm outline-none hover:bg-muted rounded-sm",
			onSelect: () => copyBlockId(block),
			children: "Copy ID"
		});
		$[12] = block;
		$[13] = t6;
	} else t6 = $[13];
	let t7;
	if ($[14] !== block) {
		t7 = /* @__PURE__ */ jsx(ContextMenuItem, {
			className: "flex cursor-pointer items-center px-2 py-1.5 text-sm outline-none hover:bg-muted rounded-sm",
			onSelect: () => copyBlockRef(block),
			children: "Copy Block Ref"
		});
		$[14] = block;
		$[15] = t7;
	} else t7 = $[15];
	let t8;
	if ($[16] !== block) {
		t8 = /* @__PURE__ */ jsx(ContextMenuItem, {
			className: "flex cursor-pointer items-center px-2 py-1.5 text-sm outline-none hover:bg-muted rounded-sm",
			onSelect: () => copyBlockEmbed(block),
			children: "Copy Block Embed"
		});
		$[16] = block;
		$[17] = t8;
	} else t8 = $[17];
	let t9;
	if ($[18] !== block || $[19] !== panelId || $[20] !== workspaceId) {
		t9 = /* @__PURE__ */ jsx(ContextMenuItem, {
			className: "flex cursor-pointer items-center px-2 py-1.5 text-sm outline-none hover:bg-muted rounded-sm",
			onSelect: () => zoomIn(block, workspaceId, panelId),
			children: "Zoom In"
		});
		$[18] = block;
		$[19] = panelId;
		$[20] = workspaceId;
		$[21] = t9;
	} else t9 = $[21];
	let t10;
	if ($[22] === Symbol.for("react.memo_cache_sentinel")) {
		t10 = /* @__PURE__ */ jsx(ContextMenuSeparator, { className: "h-px bg-border my-1" });
		$[22] = t10;
	} else t10 = $[22];
	let t11;
	if ($[23] !== setShowProperties || $[24] !== showProperties) {
		t11 = () => setShowProperties(!showProperties);
		$[23] = setShowProperties;
		$[24] = showProperties;
		$[25] = t11;
	} else t11 = $[25];
	const t12 = showProperties ? "Hide" : "Show";
	let t13;
	if ($[26] !== t11 || $[27] !== t12) {
		t13 = /* @__PURE__ */ jsxs(ContextMenuItem, {
			className: "flex cursor-pointer items-center px-2 py-1.5 text-sm outline-none hover:bg-muted rounded-sm",
			onSelect: t11,
			children: [t12, " Properties"]
		});
		$[26] = t11;
		$[27] = t12;
		$[28] = t13;
	} else t13 = $[28];
	let t14;
	if ($[29] !== t13 || $[30] !== t6 || $[31] !== t7 || $[32] !== t8 || $[33] !== t9) {
		t14 = /* @__PURE__ */ jsx(ContextMenuPortal, { children: /* @__PURE__ */ jsxs(ContextMenuContent, {
			className: "min-w-[160px] bg-background rounded-md p-1 shadow-md border border-border",
			children: [
				t6,
				t7,
				t8,
				t9,
				t10,
				t13
			]
		}) });
		$[29] = t13;
		$[30] = t6;
		$[31] = t7;
		$[32] = t8;
		$[33] = t9;
		$[34] = t14;
	} else t14 = $[34];
	let t15;
	if ($[35] !== t14 || $[36] !== t5) {
		t15 = /* @__PURE__ */ jsxs(ContextMenu, { children: [t5, t14] });
		$[35] = t14;
		$[36] = t5;
		$[37] = t15;
	} else t15 = $[37];
	return t15;
};
/** The expand/collapse button. Visibility is driven by the surrounding
*  block wrapper's hover state via Tailwind group-hover (so the layout
*  must apply `group/block` to whatever element should trigger the
*  reveal). Decoupled from the Collapsible primitive — the underlying
*  `isCollapsedProp` is the source of truth, and the layout's
*  Collapsible (if any) reads it via its `open` prop. */
var ExpandButton = (t0) => {
	const $ = c(14);
	const { block } = t0;
	const [isCollapsed, setIsCollapsed] = usePropertyValue(block, isCollapsedProp);
	const isMobile = useIsMobile();
	const hasChildren = useHasChildren(block);
	const visibilityClass = isMobile ? "opacity-100" : hasChildren ? "opacity-0 group-hover/block:opacity-100" : "opacity-0";
	let t1;
	if ($[0] !== isCollapsed || $[1] !== setIsCollapsed) {
		t1 = () => {
			withMoveTransition(async () => {
				await setIsCollapsed(!isCollapsed);
			});
		};
		$[0] = isCollapsed;
		$[1] = setIsCollapsed;
		$[2] = t1;
	} else t1 = $[2];
	const toggle = t1;
	let t2;
	if ($[3] !== toggle) {
		t2 = (e_0) => {
			e_0.stopPropagation();
			toggle();
		};
		$[3] = toggle;
		$[4] = t2;
	} else t2 = $[4];
	const t3 = isMobile ? "h-8 w-8" : "h-6 w-3";
	let t4;
	if ($[5] !== t3 || $[6] !== visibilityClass) {
		t4 = cn("expand-collapse-button p-0 hover:bg-none transition-opacity duration-200", visibilityClass, t3);
		$[5] = t3;
		$[6] = visibilityClass;
		$[7] = t4;
	} else t4 = $[7];
	const t5 = isCollapsed ? "▸" : "▾";
	let t6;
	if ($[8] !== t5) {
		t6 = /* @__PURE__ */ jsx("span", {
			className: "text-lg text-muted-foreground",
			children: t5
		});
		$[8] = t5;
		$[9] = t6;
	} else t6 = $[9];
	let t7;
	if ($[10] !== t2 || $[11] !== t4 || $[12] !== t6) {
		t7 = /* @__PURE__ */ jsx(Button, {
			variant: "ghost",
			size: "sm",
			type: "button",
			"data-block-interaction": "ignore",
			onPointerDown: _temp,
			onClick: t2,
			className: t4,
			children: t6
		});
		$[10] = t2;
		$[11] = t4;
		$[12] = t6;
		$[13] = t7;
	} else t7 = $[13];
	return t7;
};
/**
* Default block layout — owns the entire shape of a block as rendered
* (Collapsible wrapper, controls placement, body flow, focus highlight).
* Plugins contribute alternatives via `blockLayoutFacet` for blocks they
* want to redress (e.g. the video-player notes view).
*
* The `group/block` class is what makes hover-driven affordances like
* `ExpandButton` show up — any layout that wants those affordances to
* reveal on parent hover should mark its outer wrapper similarly.
*/
var DefaultBlockLayout = (t0) => {
	const $ = c(17);
	const { block, Content, Properties, Children, Footer, Controls, Header, Shell } = t0;
	const isSelected = useIsSelected(block.id);
	const isTopLevel = useIsFocalRender(block);
	const [isCollapsed] = usePropertyValue(block, isCollapsedProp);
	let t1;
	if ($[0] !== Header) {
		t1 = /* @__PURE__ */ jsx(Header, {});
		$[0] = Header;
		$[1] = t1;
	} else t1 = $[1];
	let t2;
	if ($[2] !== Children || $[3] !== Content || $[4] !== Controls || $[5] !== Footer || $[6] !== Properties || $[7] !== isCollapsed || $[8] !== isSelected || $[9] !== isTopLevel) {
		t2 = (shellProps) => {
			const { className: shellClassName, ...collapsibleProps } = shellProps;
			return /* @__PURE__ */ jsxs(Collapsible, {
				...collapsibleProps,
				open: !isCollapsed || isTopLevel,
				className: `tm-block group/block relative flex items-start gap-1 outline-none focus:outline-none focus-visible:outline-none ${isTopLevel ? "top-level-block" : ""} ${isSelected ? "bg-accent/80" : ""} ${shellClassName ?? ""}`,
				children: [/* @__PURE__ */ jsx(Controls, {}), /* @__PURE__ */ jsxs("div", {
					className: "block-body flex-grow relative flex flex-col",
					children: [
						/* @__PURE__ */ jsxs("div", {
							className: "flex flex-col rounded-sm",
							children: [/* @__PURE__ */ jsx(Content, {}), Properties && /* @__PURE__ */ jsx(Properties, {})]
						}),
						/* @__PURE__ */ jsx(CollapsibleContent, { children: /* @__PURE__ */ jsx(Children, {}) }),
						/* @__PURE__ */ jsx(Footer, {})
					]
				})]
			});
		};
		$[2] = Children;
		$[3] = Content;
		$[4] = Controls;
		$[5] = Footer;
		$[6] = Properties;
		$[7] = isCollapsed;
		$[8] = isSelected;
		$[9] = isTopLevel;
		$[10] = t2;
	} else t2 = $[10];
	let t3;
	if ($[11] !== Shell || $[12] !== t2) {
		t3 = /* @__PURE__ */ jsx(Shell, { children: t2 });
		$[11] = Shell;
		$[12] = t2;
		$[13] = t3;
	} else t3 = $[13];
	let t4;
	if ($[14] !== t1 || $[15] !== t3) {
		t4 = /* @__PURE__ */ jsxs("div", { children: [t1, t3] });
		$[14] = t1;
		$[15] = t3;
		$[16] = t4;
	} else t4 = $[16];
	return t4;
};
/**
* Stable leaf of the shell-decorator stack. Module-level, so its component
* IDENTITY never changes — the layout's `render` closure arrives as an ordinary
* prop, so when the layout hands a fresh one (every render, since it closes over
* collapse/selection/focus state) the leaf RE-RENDERS rather than remounting.
* If the leaf's type churned, React would tear down the whole block subtree
* (Collapsible → content → CodeMirror) on every selection/collapse toggle. Also
* the home of the block's 'block' shortcut surface.
*/
function BlockShellLeaf(t0) {
	const $ = c(5);
	const { block, state, render } = t0;
	useShortcutSurfaceActivations(block, "block", state.shortcutSurfaceOptions);
	let t1;
	if ($[0] !== render || $[1] !== state.shellProps) {
		t1 = render(state.shellProps);
		$[0] = render;
		$[1] = state.shellProps;
		$[2] = t1;
	} else t1 = $[2];
	let t2;
	if ($[3] !== t1) {
		t2 = /* @__PURE__ */ jsx(Fragment$1, { children: t1 });
		$[3] = t1;
		$[4] = t2;
	} else t2 = $[4];
	return t2;
}
function BlockShellDecoratorStack(t0) {
	const $ = c(19);
	const { decorators, index: t1, resolveContext, shellRef, contentRef, state, block, render } = t0;
	const index = t1 === void 0 ? 0 : t1;
	const Decorator = decorators[index];
	if (!Decorator) {
		let t2;
		if ($[0] !== block || $[1] !== render || $[2] !== state) {
			t2 = /* @__PURE__ */ jsx(BlockShellLeaf, {
				block,
				state,
				render
			});
			$[0] = block;
			$[1] = render;
			$[2] = state;
			$[3] = t2;
		} else t2 = $[3];
		return t2;
	}
	let t2;
	if ($[4] !== block || $[5] !== contentRef || $[6] !== decorators || $[7] !== index || $[8] !== render || $[9] !== resolveContext || $[10] !== shellRef) {
		t2 = (nextState) => /* @__PURE__ */ jsx(BlockShellDecoratorStack, {
			decorators,
			index: index + 1,
			resolveContext,
			shellRef,
			contentRef,
			state: nextState,
			block,
			render
		});
		$[4] = block;
		$[5] = contentRef;
		$[6] = decorators;
		$[7] = index;
		$[8] = render;
		$[9] = resolveContext;
		$[10] = shellRef;
		$[11] = t2;
	} else t2 = $[11];
	let t3;
	if ($[12] !== Decorator || $[13] !== contentRef || $[14] !== resolveContext || $[15] !== shellRef || $[16] !== state || $[17] !== t2) {
		t3 = /* @__PURE__ */ jsx(ExtensionRenderBoundary, { children: /* @__PURE__ */ jsx(Decorator, {
			resolveContext,
			shellRef,
			contentRef,
			state,
			children: t2
		}) });
		$[12] = Decorator;
		$[13] = contentRef;
		$[14] = resolveContext;
		$[15] = shellRef;
		$[16] = state;
		$[17] = t2;
		$[18] = t3;
	} else t3 = $[18];
	return t3;
}
/**
* The opt-in interactive block surface (the `Shell` slot's body). Encapsulates
* everything the editable block wrapper bears — the canonical data attributes +
* focusable tabIndex, the click handler (`blockClickHandlersFacet`), the shell
* decorators (selection/focus/paste/spatial), and `useShortcutSurfaceActivations`
* — and yields the composed `shellProps` to the layout's render-prop. A layout renders
* `<Shell>{shellProps => <wrapper {...shellProps}/>}</Shell>` to become a
* focusable/editable block; a read-only layout (a reference) omits it, so none
* of this machinery runs.
*/
function BlockShell(t0) {
	const $ = c(31);
	const { resolveContext, shellRef, contentRef, children } = t0;
	const runtime = useAppRuntime();
	const { block } = resolveContext;
	let t1;
	if ($[0] !== resolveContext.blockContext) {
		t1 = resolveContext.blockContext ?? {};
		$[0] = resolveContext.blockContext;
		$[1] = t1;
	} else t1 = $[1];
	const blockContext = t1;
	const inEditMode = useInEditMode(block.id);
	let t2;
	if ($[2] !== runtime) {
		t2 = runtime.read(blockClickHandlersFacet);
		$[2] = runtime;
		$[3] = t2;
	} else t2 = $[3];
	const resolveBlockClickHandler = t2;
	let t3;
	if ($[4] !== resolveBlockClickHandler || $[5] !== resolveContext) {
		t3 = resolveBlockClickHandler(resolveContext);
		$[4] = resolveBlockClickHandler;
		$[5] = resolveContext;
		$[6] = t3;
	} else t3 = $[6];
	const handleBlockClick = t3;
	const t4 = typeof blockContext.renderScopeId === "string" ? blockContext.renderScopeId : void 0;
	const t5 = inEditMode ? "true" : "false";
	let t6;
	if ($[7] !== handleBlockClick) {
		t6 = handleBlockClick ? (event) => {
			handleBlockClick(event);
		} : void 0;
		$[7] = handleBlockClick;
		$[8] = t6;
	} else t6 = $[8];
	let t7;
	if ($[9] !== block.id || $[10] !== shellRef || $[11] !== t4 || $[12] !== t5 || $[13] !== t6) {
		t7 = {
			"data-block-id": block.id,
			"data-render-scope-id": t4,
			"data-editing": t5,
			tabIndex: 0,
			ref: shellRef,
			onClick: t6
		};
		$[9] = block.id;
		$[10] = shellRef;
		$[11] = t4;
		$[12] = t5;
		$[13] = t6;
		$[14] = t7;
	} else t7 = $[14];
	const shellProps = t7;
	let t8;
	if ($[15] !== runtime) {
		t8 = runtime.read(blockShellDecoratorsFacet);
		$[15] = runtime;
		$[16] = t8;
	} else t8 = $[16];
	const resolveBlockShellDecorators = t8;
	let t9;
	if ($[17] !== resolveBlockShellDecorators || $[18] !== resolveContext) {
		t9 = resolveBlockShellDecorators(resolveContext);
		$[17] = resolveBlockShellDecorators;
		$[18] = resolveContext;
		$[19] = t9;
	} else t9 = $[19];
	const shellDecorators = t9;
	let t10;
	if ($[20] === Symbol.for("react.memo_cache_sentinel")) {
		t10 = {};
		$[20] = t10;
	} else t10 = $[20];
	let t11;
	if ($[21] !== shellProps) {
		t11 = {
			shellProps,
			shortcutSurfaceOptions: t10
		};
		$[21] = shellProps;
		$[22] = t11;
	} else t11 = $[22];
	const initialShellState = t11;
	let t12;
	if ($[23] !== block || $[24] !== children || $[25] !== contentRef || $[26] !== initialShellState || $[27] !== resolveContext || $[28] !== shellDecorators || $[29] !== shellRef) {
		t12 = /* @__PURE__ */ jsx(BlockShellDecoratorStack, {
			decorators: shellDecorators,
			resolveContext,
			shellRef,
			contentRef,
			state: initialShellState,
			block,
			render: children
		});
		$[23] = block;
		$[24] = children;
		$[25] = contentRef;
		$[26] = initialShellState;
		$[27] = resolveContext;
		$[28] = shellDecorators;
		$[29] = shellRef;
		$[30] = t12;
	} else t12 = $[30];
	return t12;
}
function DefaultBlockRenderer({ block, ContentRenderer: DefaultContentRenderer = MarkdownContentRenderer, EditContentRenderer = CodeMirrorContentRenderer }) {
	const repo = useRepo();
	const runtime = useAppRuntime();
	const blockContext = useBlockContext();
	const uiStateBlock = useUIStateBlock();
	const [showProperties] = usePropertyValue(block, showPropertiesProp);
	const [types] = usePropertyValue(block, typesProp);
	const [topLevelBlockId] = useUIStateProperty(topLevelBlockIdProp);
	const shellRef = useRef(null);
	const contentContainerRef = useRef(null);
	const isTopLevel = useIsFocalRender(block);
	const RawContentSlot = useMemo(() => {
		return function BlockRawContentSlot() {
			return /* @__PURE__ */ jsx(m, {
				FallbackComponent,
				children: /* @__PURE__ */ jsx(DefaultContentRenderer, { block })
			});
		};
	}, [block, DefaultContentRenderer]);
	const scopeRootId = blockContext.scopeRootId;
	const resolveContext = useMemo(() => ({
		block,
		repo,
		uiStateBlock,
		types,
		topLevelBlockId,
		scopeRootId,
		isTopLevel,
		blockContext,
		contentRenderers: [{
			id: "primary",
			renderer: RawContentSlot
		}, {
			id: "secondary",
			renderer: EditContentRenderer
		}]
	}), [
		block,
		repo,
		uiStateBlock,
		types,
		topLevelBlockId,
		scopeRootId,
		isTopLevel,
		blockContext,
		RawContentSlot,
		EditContentRenderer
	]);
	const resolveBlockLayout = runtime.read(blockLayoutFacet);
	return /* @__PURE__ */ jsx(useMemo(() => resolveBlockLayout(resolveContext).last?.render ?? DefaultBlockLayout, [resolveContext, resolveBlockLayout]), {
		block,
		Content: useMemo(() => {
			return function BlockContentSlot() {
				const contentGestureRef = useContinuousGestures(resolveContext, contentContainerRef);
				const resolveBlockContentRenderer = runtime.read(blockContentRendererFacet);
				const baseContentRenderer = useMemo(() => resolveBlockContentRenderer(resolveContext).last?.render ?? DefaultContentRenderer, [resolveBlockContentRenderer]);
				const decorateContent = runtime.read(blockContentDecoratorsFacet);
				const ContentRenderer = useMemo(() => decorateContent(resolveContext, baseContentRenderer), [decorateContent, baseContentRenderer]);
				const resolveContentSurfaceProps = runtime.read(blockContentSurfacePropsFacet);
				const contentSurfaceProps = useMemo(() => resolveContentSurfaceProps(resolveContext), [resolveContentSurfaceProps]);
				const topLevelClass = isTopLevel ? " top-level-content" : "";
				return /* @__PURE__ */ jsx("div", {
					...contentSurfaceProps,
					"data-block-visibility-target": "true",
					className: `block-content${topLevelClass}${contentSurfaceProps.className ? ` ${contentSurfaceProps.className}` : ""}`,
					ref: contentGestureRef,
					children: /* @__PURE__ */ jsx(m, {
						FallbackComponent,
						children: /* @__PURE__ */ jsx(ContentRenderer, { block })
					})
				});
			};
		}, [
			block,
			resolveContext,
			runtime,
			isTopLevel,
			DefaultContentRenderer,
			contentContainerRef
		]),
		RawContent: RawContentSlot,
		Properties: useMemo(() => {
			if (!showProperties) return null;
			return function BlockPropertiesSlot() {
				return /* @__PURE__ */ jsx(BlockProperties, { block });
			};
		}, [block, showProperties]),
		Children: useMemo(() => {
			return function BlockChildrenSlot() {
				return /* @__PURE__ */ jsx(BlockChildren, { block });
			};
		}, [block]),
		Footer: useMemo(() => {
			return function BlockFooterSlot() {
				const resolveChildrenFooterSections = runtime.read(blockChildrenFooterFacet);
				return /* @__PURE__ */ jsx(Fragment$1, { children: useMemo(() => resolveChildrenFooterSections(resolveContext), [resolveChildrenFooterSections]).map((SectionRenderer, index) => /* @__PURE__ */ jsx(m, {
					FallbackComponent,
					children: /* @__PURE__ */ jsx(SectionRenderer, { block })
				}, index)) });
			};
		}, [
			block,
			resolveContext,
			runtime
		]),
		Controls: useMemo(() => {
			return function BlockControlsSlot() {
				const isFocal = useIsFocalRender(block);
				const isMobile = useIsMobile();
				const hasChildren = useHasChildren(block);
				if (isFocal) return null;
				return /* @__PURE__ */ jsxs(Fragment$1, { children: [/* @__PURE__ */ jsxs("div", {
					className: "block-controls flex items-center",
					children: [!isMobile && /* @__PURE__ */ jsx(ExpandButton, { block }), /* @__PURE__ */ jsx(BlockBullet, { block })]
				}), isMobile && hasChildren && /* @__PURE__ */ jsx("div", {
					className: "absolute right-0 top-0 z-10 flex h-6 items-center",
					children: /* @__PURE__ */ jsx(ExpandButton, { block })
				})] });
			};
		}, [block]),
		Header: useMemo(() => {
			return function BlockHeaderSlot() {
				const resolveHeaderSections = runtime.read(blockHeaderFacet);
				return /* @__PURE__ */ jsx(Fragment$1, { children: useMemo(() => resolveHeaderSections(resolveContext), [resolveHeaderSections]).map((SectionRenderer_0, index_0) => /* @__PURE__ */ jsx(m, {
					FallbackComponent,
					children: /* @__PURE__ */ jsx(SectionRenderer_0, { block })
				}, index_0)) });
			};
		}, [
			block,
			resolveContext,
			runtime
		]),
		Shell: useMemo(() => {
			return function BlockShellSlot({ children }) {
				return /* @__PURE__ */ jsx(BlockShell, {
					resolveContext,
					shellRef,
					contentRef: contentContainerRef,
					children
				});
			};
		}, [
			resolveContext,
			shellRef,
			contentContainerRef
		])
	});
}
function _temp(e) {
	return e.stopPropagation();
}
//#endregion
export { BulletDot, DefaultBlockLayout, DefaultBlockRenderer };

//# sourceMappingURL=DefaultBlockRenderer.js.map