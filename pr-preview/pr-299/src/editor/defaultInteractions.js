import { systemToggle } from "../facets/togglable.js";
import { actionsFacet } from "../extensions/core.js";
import { ActionContextTypes } from "../shortcuts/types.js";
import { blockContentSurfacePropsFacet, blockPointerDepsFrom, blockShellDecoratorsFacet, isInteractiveContentEvent, isSelectionClick, shortcutSurfaceActivationsFacet } from "../extensions/blockInteraction.js";
import { dispatchPointerAction } from "../shortcuts/pointerAction.js";
import { editorAutocompleteExtension } from "./autocomplete.js";
import { extendBlockSelectionAction, toggleBlockSelectionAction } from "../extensions/blockSelectionAction.js";
import { blockFocusShellDecorator } from "../extensions/BlockFocusShellDecorator.js";
import { blockPasteShellDecorator } from "./BlockPasteShellDecorator.js";
import { c } from "react/compiler-runtime";
//#region src/editor/defaultInteractions.ts
var codeMirrorEditModeActivation = (context) => {
	if (context.surface !== "codemirror" || !context.editorView) return null;
	const renderScopeId = typeof context.blockContext?.renderScopeId === "string" ? context.blockContext.renderScopeId : void 0;
	return [{
		context: ActionContextTypes.EDIT_MODE_CM,
		dependencies: {
			block: context.block,
			editorView: context.editorView,
			...renderScopeId ? { renderScopeId } : {}
		}
	}];
};
var isBlockSelectionGesture = (event) => isSelectionClick(event) && !isInteractiveContentEvent(event);
var createBlockSelectionShellState = (resolveContext, state) => ({
	shellProps: {
		...state.shellProps,
		onMouseDownCapture: (event) => {
			if (isBlockSelectionGesture(event)) {
				event.preventDefault();
				return;
			}
			state.shellProps.onMouseDownCapture?.(event);
		},
		onClick: (event) => {
			if (!dispatchPointerAction(event, blockPointerDepsFrom(resolveContext, event))) state.shellProps.onClick?.(event);
		}
	},
	shortcutSurfaceOptions: state.shortcutSurfaceOptions
});
function BlockSelectionShellDecorator(t0) {
	const $ = c(6);
	const { resolveContext, state, children } = t0;
	let t1;
	if ($[0] !== resolveContext || $[1] !== state) {
		t1 = createBlockSelectionShellState(resolveContext, state);
		$[0] = resolveContext;
		$[1] = state;
		$[2] = t1;
	} else t1 = $[2];
	const nextState = t1;
	let t2;
	if ($[3] !== children || $[4] !== nextState) {
		t2 = children(nextState);
		$[3] = children;
		$[4] = nextState;
		$[5] = t2;
	} else t2 = $[5];
	return t2;
}
var blockSelectionShellDecorator = () => BlockSelectionShellDecorator;
var contentTouchStarts = /* @__PURE__ */ new Map();
var TAP_MOVE_PX = 10;
var TAP_MAX_MS = 300;
var isTap = (start, end) => Math.abs(end.x - start.x) <= TAP_MOVE_PX && Math.abs(end.y - start.y) <= TAP_MOVE_PX && end.time - start.time <= TAP_MAX_MS;
/**
* Core pointer-gesture recognition on a block's CONTENT surface: routes a
* pointerdown-phase mouse gesture and a touch tap through the same pointer
* dispatch the shell uses for clicks, with the block's deps supplied. The
* surface only RECOGNISES and routes; what a gesture DOES is a bound
* `block-pointer` action (e.g. vim's double-click/tap-to-edit), so an unbound
* gesture is a no-op.
*
* Lives on the content surface, not the shell, so it never fires for the
* bullet, controls, or properties chrome — only the block's own content — and
* the context's `pointerTargetFilter` keeps it off interactive descendants and
* the CodeMirror editor while editing (where a double-click should select a
* word natively).
*
* Each branch recognises a discrete gesture, then routes it. A multi-click
* (`detail >= 2`) is the mouse gesture worth routing at the pointerdown phase —
* the action's binding picks the exact count (`detail: 2` for double-click),
* and binding at pointerdown (not `click`) lets the dispatch's preventDefault
* beat native word-selection. A single press isn't a gesture, so it's left for
* the shell's click. Touch has no single "tap" event, so the tap is recognised
* here (movement/duration thresholds) before routing.
*/
var blockContentPointerGestures = (context) => {
	const dispatchGesture = (event) => {
		dispatchPointerAction(event, blockPointerDepsFrom(context, event));
	};
	return {
		onMouseDownCapture: (event) => {
			if (event.defaultPrevented) return;
			if (event.detail < 2) return;
			dispatchGesture(event);
		},
		onTouchStart: (event) => {
			const touch = event.touches[0];
			if (!touch) return;
			contentTouchStarts.set(context.block.id, {
				x: touch.clientX,
				y: touch.clientY,
				time: Date.now()
			});
		},
		onTouchEnd: (event) => {
			const start = contentTouchStarts.get(context.block.id);
			contentTouchStarts.delete(context.block.id);
			const touch = event.changedTouches[0];
			if (!start || !touch) return;
			if (!isTap(start, {
				x: touch.clientX,
				y: touch.clientY,
				time: Date.now()
			})) return;
			dispatchGesture(event);
		}
	};
};
var defaultEditorInteractionExtension = systemToggle({
	id: "system:default-editor-interactions",
	name: "Default editor interactions",
	description: "Baseline block-interaction handlers (click-to-edit, selection, focus transitions).",
	essential: true
}).of([
	blockShellDecoratorsFacet.of(blockSelectionShellDecorator, { source: "default-block-selection" }),
	blockShellDecoratorsFacet.of(blockPasteShellDecorator, { source: "default-block-paste" }),
	blockShellDecoratorsFacet.of(blockFocusShellDecorator, {
		precedence: 1e3,
		source: "default-block-focus"
	}),
	blockContentSurfacePropsFacet.of(blockContentPointerGestures, { source: "default-content-gestures" }),
	shortcutSurfaceActivationsFacet.of(codeMirrorEditModeActivation, { source: "codemirror-edit-mode" }),
	actionsFacet.of(extendBlockSelectionAction, { source: "default-block-selection" }),
	actionsFacet.of(toggleBlockSelectionAction, { source: "default-block-selection" }),
	editorAutocompleteExtension
]);
//#endregion
export { defaultEditorInteractionExtension };

//# sourceMappingURL=defaultInteractions.js.map