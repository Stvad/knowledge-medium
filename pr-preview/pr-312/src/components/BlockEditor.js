import { editorFocusRequestProp, editorSelection, exitEditModeForBlock, isFocusedBlock } from "../data/properties.js";
import debounce from "../../node_modules/lodash-es/debounce.js";
import { EditorSelection } from "../../node_modules/@codemirror/state/dist/index.js";
import { EditorView } from "../../node_modules/@codemirror/view/dist/index.js";
import { useContentRevision, usePropertyValue } from "../hooks/block.js";
import { useBlockContext } from "../context/block.js";
import { useInEditMode, useIsEditing, useUIStateBlock } from "../data/globalState.js";
import { clampSelectionToLength, placeCursorAtCoords, placeCursorAtX } from "../utils/codemirror.js";
import ReactCodeMirror from "../../node_modules/@uiw/react-codemirror/esm/index.js";
import { shouldExitEditModeAfterBlur } from "../utils/dom.js";
import { keyboardAwareScroll } from "../utils/keyboardAwareScroll.js";
import { useShortcutSurfaceActivations } from "../extensions/useShortcutSurfaceActivations.js";
import { resolveEditModeKeepalive } from "./editModeKeepalive.js";
import { notifyBlockEditResumed, notifyBlockEditSettled } from "../editor/editSettleSignal.js";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { jsx } from "react/jsx-runtime";
//#region src/components/BlockEditor.tsx
var BlockEditor = ({ block, ref, ...codeMirrorProps }) => {
	const blockEditData = useContentRevision(block);
	const cm = useRef(null);
	const [editorView, setEditorView] = useState(null);
	const [isEditing] = useIsEditing();
	const inEditMode = useInEditMode(block.id);
	const blockContext = useBlockContext();
	const renderScopeId = typeof blockContext.renderScopeId === "string" ? blockContext.renderScopeId : void 0;
	const initialContent = useRef(blockEditData?.content ?? "");
	const lastCommittedContent = useRef(blockEditData?.content ?? "");
	const lastAdoptedUpdatedAt = useRef(blockEditData?.updatedAt ?? 0);
	const uiStateBlock = useUIStateBlock();
	const [focusRequestId] = usePropertyValue(uiStateBlock, editorFocusRequestProp);
	const pushChange = useRef(debounce((value) => {
		block.setContent(value);
	}, 300)).current;
	const pushSelection = useRef(debounce((selection) => {
		if (!isFocusedBlock(uiStateBlock, selection.blockId, renderScopeId)) return;
		uiStateBlock.set(editorSelection, selection);
	}, 150)).current;
	const flushDebouncers = useCallback(() => {
		pushChange.flush();
		pushSelection.flush();
	}, [pushChange, pushSelection]);
	useLayoutEffect(() => flushDebouncers, [flushDebouncers]);
	useEffect(() => {
		notifyBlockEditResumed(block.id);
		return () => notifyBlockEditSettled(block.id);
	}, [block.id]);
	useEffect(() => {
		if (!blockEditData || !editorView) return;
		const incomingUpdatedAt = blockEditData.updatedAt;
		const live = editorView.state.doc.toString();
		const incoming = blockEditData.content;
		if (live === incoming) {
			lastCommittedContent.current = incoming;
			if (incomingUpdatedAt > lastAdoptedUpdatedAt.current) lastAdoptedUpdatedAt.current = incomingUpdatedAt;
			return;
		}
		if (incomingUpdatedAt <= lastAdoptedUpdatedAt.current) return;
		if (live !== lastCommittedContent.current) return;
		editorView.dispatch({
			changes: {
				from: 0,
				to: live.length,
				insert: incoming
			},
			selection: clampSelectionToLength(editorView.state.selection, incoming.length)
		});
		pushChange.cancel();
		lastCommittedContent.current = incoming;
		lastAdoptedUpdatedAt.current = incomingUpdatedAt;
	}, [
		blockEditData,
		editorView,
		block.id
	]);
	useEffect(() => {
		if (!isEditing || !inEditMode || !editorView) return;
		let cancelled = false;
		const frameId = requestAnimationFrame(() => {
			if (!editorView || cancelled) return;
			editorView.focus();
			const selection = uiStateBlock.peekProperty(editorSelection);
			if (!cancelled && selection?.blockId === block.id) {
				if (selection.x !== void 0 && selection.y !== void 0) placeCursorAtCoords(editorView, {
					x: selection.x,
					y: selection.y
				});
				else if (selection.x !== void 0) placeCursorAtX(editorView, selection.x, selection.line === "last");
				else if (selection.start !== void 0) editorView.dispatch({ selection: clampSelectionToLength(EditorSelection.single(selection.start, selection.end ?? selection.start), editorView.state.doc.length) });
			}
			if (cancelled) return;
			editorView.dispatch({ effects: EditorView.scrollIntoView(editorView.state.selection.main.head) });
		});
		return () => {
			cancelled = true;
			cancelAnimationFrame(frameId);
		};
	}, [
		block.id,
		editorView,
		focusRequestId,
		inEditMode,
		isEditing,
		uiStateBlock
	]);
	useShortcutSurfaceActivations(block, "codemirror", useMemo(() => ({ editorView: editorView ?? void 0 }), [editorView]));
	const { extensions: providedExtensions, ...restCodeMirrorProps } = codeMirrorProps;
	const mergedExtensions = useMemo(() => [keyboardAwareScroll(), ...providedExtensions ?? []], [providedExtensions]);
	if (!blockEditData) return null;
	const forwardRefValue = (value) => {
		if (!ref) return;
		if (typeof ref === "function") ref(value);
		else ref.current = value;
	};
	return /* @__PURE__ */ jsx(ReactCodeMirror, {
		theme: "none",
		ref: (value) => {
			cm.current = value;
			setEditorView(value?.view ?? null);
			forwardRefValue(value);
		},
		value: initialContent.current,
		onChange: (value) => {
			pushChange(value);
		},
		onUpdate: (viewUpdate) => {
			if (viewUpdate.selectionSet) {
				const selection = viewUpdate.state.selection.main;
				pushSelection({
					blockId: block.id,
					start: selection.from,
					end: selection.to
				});
			}
		},
		onBlur: () => {
			flushDebouncers();
			requestAnimationFrame(() => {
				if (!document.hasFocus() || !shouldExitEditModeAfterBlur(document.activeElement)) return;
				const keepalive = resolveEditModeKeepalive();
				if (keepalive === "refocus") {
					cm.current?.view?.focus();
					return;
				}
				if (keepalive === "yield") return;
				exitEditModeForBlock(uiStateBlock, block.id, renderScopeId);
			});
		},
		extensions: mergedExtensions,
		...restCodeMirrorProps
	});
};
BlockEditor.displayName = "BlockEditor";
//#endregion
export { BlockEditor };

//# sourceMappingURL=BlockEditor.js.map