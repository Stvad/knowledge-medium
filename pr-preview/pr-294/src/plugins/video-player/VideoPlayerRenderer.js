import { Button } from "../../components/ui/button.js";
import { useContent, usePropertyValue } from "../../hooks/block.js";
import { PanelRightClose } from "../../../node_modules/lucide-react/dist/esm/icons/panel-right-close.js";
import { PanelRightOpen } from "../../../node_modules/lucide-react/dist/esm/icons/panel-right-open.js";
import { NestedBlockContextProvider, useBlockContext } from "../../context/block.js";
import { useUIStateBlock } from "../../data/globalState.js";
import { DefaultBlockLayout, DefaultBlockRenderer } from "../../components/renderer/DefaultBlockRenderer.js";
import { registerVideoPlayer } from "./registry.js";
import { videoNotesPaneRatioProp, videoPlayerViewProp } from "./view.js";
import { enterVideoNotesView } from "./notes.js";
import { src_default } from "../../../node_modules/react-player/dist/index.js";
import { useEffect, useRef, useState } from "react";
import { c } from "react/compiler-runtime";
import { jsx, jsxs } from "react/jsx-runtime";
//#region src/plugins/video-player/VideoPlayerRenderer.tsx
var MIN_VIDEO_NOTES_PANE_RATIO = .28;
var MAX_VIDEO_NOTES_PANE_RATIO = .9;
var VIDEO_NOTES_DESKTOP_BREAKPOINT = 768;
var VIDEO_NOTES_KEYBOARD_STEP = .05;
var URL_ONLY_WHITESPACE_RE = /\s/;
var clampVideoNotesPaneRatio = (ratio) => Math.min(MAX_VIDEO_NOTES_PANE_RATIO, Math.max(MIN_VIDEO_NOTES_PANE_RATIO, ratio));
var videoNotesPanePercent = (ratio) => `${(ratio * 100).toFixed(2)}%`;
var standaloneHttpUrl = (content) => {
	const url = content.trim();
	if (!url || URL_ONLY_WHITESPACE_RE.test(url)) return null;
	try {
		const parsed = new URL(url);
		return parsed.protocol === "http:" || parsed.protocol === "https:" ? url : null;
	} catch {
		return null;
	}
};
var VideoPlayerContentRenderer = (t0) => {
	const $ = c(27);
	const { block } = t0;
	const content = useContent(block);
	const [view] = usePropertyValue(block, videoPlayerViewProp);
	const uiStateBlock = useUIStateBlock();
	const blockContext = useBlockContext();
	const player = useRef(null);
	const containerRef = useRef(null);
	const [isPlaying, setIsPlaying] = useState(false);
	const inNotesView = view === "notes";
	let t1;
	if ($[0] !== inNotesView) {
		t1 = inNotesView ? { width: "min(100%, calc(var(--video-notes-pane-height) * 16 / 9))" } : void 0;
		$[0] = inNotesView;
		$[1] = t1;
	} else t1 = $[1];
	const notesPlayerFrameStyle = t1;
	let t2;
	if ($[2] !== inNotesView) {
		t2 = inNotesView ? {
			width: "100%",
			height: "auto",
			aspectRatio: "16 / 9"
		} : void 0;
		$[2] = inNotesView;
		$[3] = t2;
	} else t2 = $[3];
	const notesPlayerStyle = t2;
	let t3;
	if ($[4] === Symbol.for("react.memo_cache_sentinel")) {
		t3 = () => {
			const focusTarget = player.current ?? containerRef.current;
			if (!focusTarget) return false;
			containerRef.current?.scrollIntoView({ block: "nearest" });
			focusTarget.focus({ preventScroll: true });
			return true;
		};
		$[4] = t3;
	} else t3 = $[4];
	const focusPlayer = t3;
	let t4;
	if ($[5] === Symbol.for("react.memo_cache_sentinel")) {
		t4 = () => {
			const container = containerRef.current;
			const playerElement = player.current;
			const activeElement = document.activeElement;
			if (activeElement && (activeElement === playerElement || activeElement === container || Boolean(container?.contains(activeElement)))) return true;
			return Boolean(playerElement?.shadowRoot?.activeElement);
		};
		$[5] = t4;
	} else t4 = $[5];
	const hasPlayerFocus = t4;
	const renderScopeId = typeof blockContext.renderScopeId === "string" ? blockContext.renderScopeId : void 0;
	let t5;
	let t6;
	if ($[6] !== block.id || $[7] !== renderScopeId) {
		t5 = () => registerVideoPlayer(block.id, renderScopeId, {
			getCurrentTime: () => player.current?.currentTime,
			focus: focusPlayer,
			hasFocus: hasPlayerFocus,
			seekTo: (seconds) => {
				if (!player.current) return;
				player.current.currentTime = seconds;
				focusPlayer();
				setIsPlaying(true);
			}
		});
		t6 = [
			block.id,
			renderScopeId,
			focusPlayer,
			hasPlayerFocus
		];
		$[6] = block.id;
		$[7] = renderScopeId;
		$[8] = t5;
		$[9] = t6;
	} else {
		t5 = $[8];
		t6 = $[9];
	}
	useEffect(t5, t6);
	const t7 = inNotesView ? "grid h-full w-full place-items-center bg-black" : "group/video-player relative aspect-video";
	const t8 = inNotesView ? "m-auto max-h-full max-w-full" : "h-full w-full";
	let t9;
	if ($[10] !== content || $[11] !== isPlaying || $[12] !== notesPlayerStyle) {
		t9 = /* @__PURE__ */ jsx(src_default, {
			ref: player,
			src: content,
			playing: isPlaying,
			controls: true,
			tabIndex: 0,
			"aria-label": "Video player",
			width: "100%",
			height: "100%",
			style: notesPlayerStyle
		});
		$[10] = content;
		$[11] = isPlaying;
		$[12] = notesPlayerStyle;
		$[13] = t9;
	} else t9 = $[13];
	let t10;
	if ($[14] !== notesPlayerFrameStyle || $[15] !== t8 || $[16] !== t9) {
		t10 = /* @__PURE__ */ jsx("div", {
			className: t8,
			style: notesPlayerFrameStyle,
			children: t9
		});
		$[14] = notesPlayerFrameStyle;
		$[15] = t8;
		$[16] = t9;
		$[17] = t10;
	} else t10 = $[17];
	let t11;
	if ($[18] !== block || $[19] !== blockContext.renderScopeId || $[20] !== inNotesView || $[21] !== uiStateBlock) {
		t11 = !inNotesView && /* @__PURE__ */ jsx(Button, {
			type: "button",
			variant: "secondary",
			size: "icon",
			"aria-label": "Open video notes view",
			title: "Open video notes view",
			className: "absolute right-2 top-2 opacity-0 shadow-md transition-opacity group-hover/video-player:opacity-100 focus-visible:opacity-100",
			onClick: () => {
				enterVideoNotesView(block, uiStateBlock, typeof blockContext.renderScopeId === "string" ? blockContext.renderScopeId : void 0);
			},
			children: /* @__PURE__ */ jsx(PanelRightOpen, { className: "h-4 w-4" })
		});
		$[18] = block;
		$[19] = blockContext.renderScopeId;
		$[20] = inNotesView;
		$[21] = uiStateBlock;
		$[22] = t11;
	} else t11 = $[22];
	let t12;
	if ($[23] !== t10 || $[24] !== t11 || $[25] !== t7) {
		t12 = /* @__PURE__ */ jsxs("div", {
			ref: containerRef,
			className: t7,
			children: [t10, t11]
		});
		$[23] = t10;
		$[24] = t11;
		$[25] = t7;
		$[26] = t12;
	} else t12 = $[26];
	return t12;
};
/**
* Layout for the video block itself. Subscribes to the view property so a
* toggle on the *parent layout* re-renders without forcing every consumer to
* re-resolve the layout facet. Falls through to the default vertical layout
* unless the block is in notes view, where it lays out content+children
* side-by-side as a fullscreen overlay.
*/
var VideoPlayerLayout = (slots) => {
	const $ = c(64);
	const [view, setView] = usePropertyValue(slots.block, videoPlayerViewProp);
	const [storedVideoPaneRatio, setStoredVideoPaneRatio] = usePropertyValue(slots.block, videoNotesPaneRatioProp);
	const [draftVideoPaneRatio, setDraftVideoPaneRatio] = useState(null);
	const containerRef = useRef(null);
	const dragCleanupRef = useRef(null);
	const videoPaneRatio = draftVideoPaneRatio ?? storedVideoPaneRatio;
	let t0;
	let t1;
	if ($[0] === Symbol.for("react.memo_cache_sentinel")) {
		t0 = () => () => {
			dragCleanupRef.current?.();
		};
		t1 = [];
		$[0] = t0;
		$[1] = t1;
	} else {
		t0 = $[0];
		t1 = $[1];
	}
	useEffect(t0, t1);
	let t2;
	if ($[2] !== setStoredVideoPaneRatio || $[3] !== videoPaneRatio) {
		t2 = (event) => {
			if (event.button !== 0) return;
			const container = containerRef.current;
			if (!container) return;
			dragCleanupRef.current?.();
			const rect = container.getBoundingClientRect();
			const isDesktopLayout = rect.width >= VIDEO_NOTES_DESKTOP_BREAKPOINT;
			const totalSize = isDesktopLayout ? rect.width : rect.height;
			if (totalSize <= 0) return;
			const previousCursor = document.body.style.cursor;
			const previousUserSelect = document.body.style.userSelect;
			let latestRatio = clampVideoNotesPaneRatio(videoPaneRatio);
			const updateRatio = (clientX, clientY) => {
				latestRatio = clampVideoNotesPaneRatio((isDesktopLayout ? clientX - rect.left : clientY - rect.top) / totalSize);
				setDraftVideoPaneRatio(latestRatio);
			};
			const handlePointerMove = (moveEvent) => {
				moveEvent.preventDefault();
				updateRatio(moveEvent.clientX, moveEvent.clientY);
			};
			const cleanupPointerListeners = () => {
				window.removeEventListener("pointermove", handlePointerMove);
				window.removeEventListener("pointerup", handlePointerUp);
				window.removeEventListener("pointercancel", handlePointerCancel);
				document.body.style.cursor = previousCursor;
				document.body.style.userSelect = previousUserSelect;
				dragCleanupRef.current = null;
			};
			const finishResize = (commit) => {
				cleanupPointerListeners();
				setDraftVideoPaneRatio(null);
				if (commit) setStoredVideoPaneRatio(latestRatio);
			};
			const handlePointerUp = (upEvent) => {
				upEvent.preventDefault();
				finishResize(true);
			};
			const handlePointerCancel = (cancelEvent) => {
				cancelEvent.preventDefault();
				finishResize(false);
			};
			document.body.style.cursor = isDesktopLayout ? "col-resize" : "row-resize";
			document.body.style.userSelect = "none";
			window.addEventListener("pointermove", handlePointerMove, { passive: false });
			window.addEventListener("pointerup", handlePointerUp, { passive: false });
			window.addEventListener("pointercancel", handlePointerCancel, { passive: false });
			dragCleanupRef.current = cleanupPointerListeners;
			event.preventDefault();
			updateRatio(event.clientX, event.clientY);
		};
		$[2] = setStoredVideoPaneRatio;
		$[3] = videoPaneRatio;
		$[4] = t2;
	} else t2 = $[4];
	const handleResizePointerDown = t2;
	let t3;
	if ($[5] !== setStoredVideoPaneRatio || $[6] !== videoPaneRatio) {
		t3 = (event_0) => {
			const delta = {
				ArrowDown: VIDEO_NOTES_KEYBOARD_STEP,
				ArrowRight: VIDEO_NOTES_KEYBOARD_STEP,
				ArrowLeft: -VIDEO_NOTES_KEYBOARD_STEP,
				ArrowUp: -VIDEO_NOTES_KEYBOARD_STEP,
				End: MAX_VIDEO_NOTES_PANE_RATIO - videoPaneRatio,
				Home: MIN_VIDEO_NOTES_PANE_RATIO - videoPaneRatio
			}[event_0.key];
			if (delta === void 0) return;
			event_0.preventDefault();
			setDraftVideoPaneRatio(null);
			setStoredVideoPaneRatio(clampVideoNotesPaneRatio(videoPaneRatio + delta));
		};
		$[5] = setStoredVideoPaneRatio;
		$[6] = videoPaneRatio;
		$[7] = t3;
	} else t3 = $[7];
	const handleResizeKeyDown = t3;
	if (view !== "notes") {
		let t4;
		if ($[8] !== slots) {
			t4 = /* @__PURE__ */ jsx(DefaultBlockLayout, { ...slots });
			$[8] = slots;
			$[9] = t4;
		} else t4 = $[9];
		return t4;
	}
	const { Children, Shell } = slots;
	let clampedVideoPaneRatio;
	let t4;
	if ($[10] !== videoPaneRatio) {
		clampedVideoPaneRatio = clampVideoNotesPaneRatio(videoPaneRatio);
		t4 = videoNotesPanePercent(clampedVideoPaneRatio);
		$[10] = videoPaneRatio;
		$[11] = clampedVideoPaneRatio;
		$[12] = t4;
	} else {
		clampedVideoPaneRatio = $[11];
		t4 = $[12];
	}
	const t5 = String(clampedVideoPaneRatio);
	let t6;
	if ($[13] !== t4 || $[14] !== t5) {
		t6 = {
			flexBasis: t4,
			"--video-notes-pane-ratio": t5
		};
		$[13] = t4;
		$[14] = t5;
		$[15] = t6;
	} else t6 = $[15];
	const videoPaneStyle = t6;
	const t7 = 1 - clampedVideoPaneRatio;
	let t8;
	if ($[16] !== t7) {
		t8 = videoNotesPanePercent(t7);
		$[16] = t7;
		$[17] = t8;
	} else t8 = $[17];
	let t9;
	if ($[18] !== t8) {
		t9 = { flexBasis: t8 };
		$[18] = t8;
		$[19] = t9;
	} else t9 = $[19];
	const notesPaneStyle = t9;
	let t10;
	if ($[20] !== slots.block) {
		t10 = /* @__PURE__ */ jsx(VideoPlayerContentRenderer, { block: slots.block });
		$[20] = slots.block;
		$[21] = t10;
	} else t10 = $[21];
	let t11;
	if ($[22] !== t10 || $[23] !== videoPaneStyle) {
		t11 = /* @__PURE__ */ jsx("section", {
			className: "min-h-0 min-w-0 flex-none bg-black [--video-notes-pane-height:calc(100vh*var(--video-notes-pane-ratio))] md:[--video-notes-pane-height:100vh]",
			style: videoPaneStyle,
			children: t10
		});
		$[22] = t10;
		$[23] = videoPaneStyle;
		$[24] = t11;
	} else t11 = $[24];
	let t12;
	let t13;
	if ($[25] === Symbol.for("react.memo_cache_sentinel")) {
		t12 = Math.round(MAX_VIDEO_NOTES_PANE_RATIO * 100);
		t13 = Math.round(MIN_VIDEO_NOTES_PANE_RATIO * 100);
		$[25] = t12;
		$[26] = t13;
	} else {
		t12 = $[25];
		t13 = $[26];
	}
	let t14;
	if ($[27] !== clampedVideoPaneRatio) {
		t14 = Math.round(clampedVideoPaneRatio * 100);
		$[27] = clampedVideoPaneRatio;
		$[28] = t14;
	} else t14 = $[28];
	let t15;
	if ($[29] === Symbol.for("react.memo_cache_sentinel")) {
		t15 = /* @__PURE__ */ jsx("span", { className: "h-1 w-10 rounded-full bg-background/80 transition-colors group-hover/resizer:bg-primary-foreground/90 md:h-10 md:w-1" });
		$[29] = t15;
	} else t15 = $[29];
	let t16;
	if ($[30] !== handleResizeKeyDown || $[31] !== handleResizePointerDown || $[32] !== t14) {
		t16 = /* @__PURE__ */ jsx("div", {
			role: "separator",
			tabIndex: 0,
			"aria-label": "Resize video notes panes",
			"aria-orientation": "horizontal",
			"aria-valuemax": t12,
			"aria-valuemin": t13,
			"aria-valuenow": t14,
			className: "group/resizer flex h-2 w-full flex-none cursor-row-resize touch-none items-center justify-center bg-border/80 outline-none transition-colors hover:bg-primary/60 focus-visible:bg-primary/70 focus-visible:ring-1 focus-visible:ring-ring md:hidden",
			title: "Resize video notes panes",
			onKeyDown: handleResizeKeyDown,
			onPointerDown: handleResizePointerDown,
			children: t15
		});
		$[30] = handleResizeKeyDown;
		$[31] = handleResizePointerDown;
		$[32] = t14;
		$[33] = t16;
	} else t16 = $[33];
	let t17;
	let t18;
	if ($[34] === Symbol.for("react.memo_cache_sentinel")) {
		t17 = Math.round(MAX_VIDEO_NOTES_PANE_RATIO * 100);
		t18 = Math.round(MIN_VIDEO_NOTES_PANE_RATIO * 100);
		$[34] = t17;
		$[35] = t18;
	} else {
		t17 = $[34];
		t18 = $[35];
	}
	let t19;
	if ($[36] !== clampedVideoPaneRatio) {
		t19 = Math.round(clampedVideoPaneRatio * 100);
		$[36] = clampedVideoPaneRatio;
		$[37] = t19;
	} else t19 = $[37];
	let t20;
	if ($[38] === Symbol.for("react.memo_cache_sentinel")) {
		t20 = /* @__PURE__ */ jsx("span", { className: "h-10 w-1 rounded-full bg-background/80 transition-colors group-hover/resizer:bg-primary-foreground/90" });
		$[38] = t20;
	} else t20 = $[38];
	let t21;
	if ($[39] !== handleResizeKeyDown || $[40] !== handleResizePointerDown || $[41] !== t19) {
		t21 = /* @__PURE__ */ jsx("div", {
			role: "separator",
			tabIndex: 0,
			"aria-label": "Resize video notes panes",
			"aria-orientation": "vertical",
			"aria-valuemax": t17,
			"aria-valuemin": t18,
			"aria-valuenow": t19,
			className: "group/resizer hidden h-full w-2 flex-none cursor-col-resize touch-none items-center justify-center bg-border/80 outline-none transition-colors hover:bg-primary/60 focus-visible:bg-primary/70 focus-visible:ring-1 focus-visible:ring-ring md:flex",
			title: "Resize video notes panes",
			onKeyDown: handleResizeKeyDown,
			onPointerDown: handleResizePointerDown,
			children: t20
		});
		$[39] = handleResizeKeyDown;
		$[40] = handleResizePointerDown;
		$[41] = t19;
		$[42] = t21;
	} else t21 = $[42];
	let t22;
	if ($[43] !== setView) {
		t22 = () => setView("default");
		$[43] = setView;
		$[44] = t22;
	} else t22 = $[44];
	let t23;
	if ($[45] === Symbol.for("react.memo_cache_sentinel")) {
		t23 = /* @__PURE__ */ jsx(PanelRightClose, { className: "h-4 w-4" });
		$[45] = t23;
	} else t23 = $[45];
	let t24;
	if ($[46] !== t22) {
		t24 = /* @__PURE__ */ jsx("div", {
			className: "pointer-events-none sticky top-2 z-10 -mb-9 flex justify-end",
			children: /* @__PURE__ */ jsx(Button, {
				type: "button",
				variant: "ghost",
				size: "icon",
				"aria-label": "Close video notes view",
				title: "Close video notes view",
				className: "pointer-events-auto",
				onClick: t22,
				children: t23
			})
		});
		$[46] = t22;
		$[47] = t24;
	} else t24 = $[47];
	let t25;
	if ($[48] !== Children) {
		t25 = /* @__PURE__ */ jsx(Children, {});
		$[48] = Children;
		$[49] = t25;
	} else t25 = $[49];
	let t26;
	if ($[50] !== notesPaneStyle || $[51] !== t24 || $[52] !== t25) {
		t26 = /* @__PURE__ */ jsxs("aside", {
			className: "min-h-0 min-w-0 flex-none overflow-y-auto bg-background p-3",
			style: notesPaneStyle,
			children: [t24, t25]
		});
		$[50] = notesPaneStyle;
		$[51] = t24;
		$[52] = t25;
		$[53] = t26;
	} else t26 = $[53];
	let t27;
	if ($[54] !== t11 || $[55] !== t16 || $[56] !== t21 || $[57] !== t26) {
		t27 = /* @__PURE__ */ jsxs("div", {
			ref: containerRef,
			className: "fixed inset-0 z-50 flex flex-col bg-background text-foreground md:flex-row",
			children: [
				t11,
				t16,
				t21,
				t26
			]
		});
		$[54] = t11;
		$[55] = t16;
		$[56] = t21;
		$[57] = t26;
		$[58] = t27;
	} else t27 = $[58];
	const notesView = t27;
	let t28;
	if ($[59] !== notesView) {
		t28 = () => notesView;
		$[59] = notesView;
		$[60] = t28;
	} else t28 = $[60];
	let t29;
	if ($[61] !== Shell || $[62] !== t28) {
		t29 = /* @__PURE__ */ jsx(Shell, { children: t28 });
		$[61] = Shell;
		$[62] = t28;
		$[63] = t29;
	} else t29 = $[63];
	return t29;
};
/**
* Only contribute a layout for the actual video block — child note blocks
* inherit `videoPlayerBlockId` from the surrounding NestedBlockContext, so we
* gate on `block.id === videoPlayerBlockId` to leave child layouts alone.
*
* Registered as a variant on `blockLayoutFacet` (see migration to
* defineVariantFacet); the consumer uses `last` so this single variant
* wins whenever the gate matches — matching the previous last-wins
* behavior of the facet.
*/
var videoPlayerLayoutContribution = (ctx) => {
	if (ctx.blockContext?.videoPlayerBlockId !== ctx.block.id) return null;
	return {
		id: "video-player",
		label: "Video player",
		render: VideoPlayerLayout
	};
};
var VideoPlayerRenderer = (props) => {
	const $ = c(7);
	let t0;
	if ($[0] !== props.block.id) {
		t0 = { videoPlayerBlockId: props.block.id };
		$[0] = props.block.id;
		$[1] = t0;
	} else t0 = $[1];
	let t1;
	if ($[2] !== props) {
		t1 = /* @__PURE__ */ jsx(DefaultBlockRenderer, {
			...props,
			ContentRenderer: VideoPlayerContentRenderer
		});
		$[2] = props;
		$[3] = t1;
	} else t1 = $[3];
	let t2;
	if ($[4] !== t0 || $[5] !== t1) {
		t2 = /* @__PURE__ */ jsx(NestedBlockContextProvider, {
			overrides: t0,
			children: t1
		});
		$[4] = t0;
		$[5] = t1;
		$[6] = t2;
	} else t2 = $[6];
	return t2;
};
VideoPlayerRenderer.canRender = ({ block }) => {
	const blockData = block.peek();
	const url = blockData ? standaloneHttpUrl(blockData.content) : null;
	return !!(url && src_default.canPlay?.(url));
};
VideoPlayerRenderer.priority = () => 5;
//#endregion
export { VideoPlayerRenderer, videoPlayerLayoutContribution };

//# sourceMappingURL=VideoPlayerRenderer.js.map