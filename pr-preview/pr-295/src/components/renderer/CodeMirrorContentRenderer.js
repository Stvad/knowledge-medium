import { editorSelection, focusBlock } from "../../data/properties.js";
import { codeMirrorExtensionsFacet } from "../../editor/codeMirrorExtensions.js";
import { EditorSelection } from "../../../node_modules/@codemirror/state/dist/index.js";
import { useRepo } from "../../context/repo.js";
import { useAppRuntime } from "../../extensions/runtimeContext.js";
import { useBlockContext } from "../../context/block.js";
import { useUIStateBlock } from "../../data/globalState.js";
import { createMinimalMarkdownConfig } from "../../utils/codemirror.js";
import { BlockEditor } from "../BlockEditor.js";
import { pasteChordIntent, pasteEditModeMultilineText, planEditModeMultilinePaste, planSingleBlockPaste, resolvePasteWithMediaCapture } from "../../paste/operations.js";
import { createFieldCreationKeydownExtension } from "./fieldCreationKeydown.js";
import { useRef } from "react";
import { c } from "react/compiler-runtime";
import { jsx } from "react/jsx-runtime";
//#region src/components/renderer/CodeMirrorContentRenderer.tsx
function CodeMirrorContentRenderer(t0) {
	const $ = c(16);
	const { block } = t0;
	const repo = useRepo();
	const runtime = useAppRuntime();
	const uiStateBlock = useUIStateBlock();
	const blockContext = useBlockContext();
	const editorRef = useRef(null);
	const pasteIntentRef = useRef("split");
	let t1;
	if ($[0] !== block || $[1] !== repo || $[2] !== runtime) {
		const fieldCreationExtension = createFieldCreationKeydownExtension(block, repo);
		t1 = createMinimalMarkdownConfig([...runtime.read(codeMirrorExtensionsFacet)({
			repo,
			block
		}), fieldCreationExtension]);
		$[0] = block;
		$[1] = repo;
		$[2] = runtime;
		$[3] = t1;
	} else t1 = $[3];
	const extensions = t1;
	let t2;
	if ($[4] === Symbol.for("react.memo_cache_sentinel")) {
		t2 = (e) => {
			const intent = pasteChordIntent(e);
			if (intent) pasteIntentRef.current = intent;
		};
		$[4] = t2;
	} else t2 = $[4];
	const handleKeyDownCapture = t2;
	let t3;
	if ($[5] !== block || $[6] !== blockContext || $[7] !== repo || $[8] !== runtime || $[9] !== uiStateBlock) {
		t3 = async (e_0) => {
			e_0.stopPropagation();
			if (repo.isReadOnly) return;
			const files = e_0.clipboardData?.files;
			const fileList = files && files.length > 0 ? Array.from(files) : [];
			const text = e_0.clipboardData?.getData("text/plain") ?? "";
			if (!text && fileList.length === 0) return;
			const intent_0 = pasteIntentRef.current;
			pasteIntentRef.current = "split";
			const html = e_0.clipboardData?.getData("text/html") || void 0;
			e_0.preventDefault();
			const editorView = editorRef.current?.view;
			if (!editorView) return;
			const selection = editorView.state.selection.main;
			const resolved = await resolvePasteWithMediaCapture(runtime, {
				text,
				html,
				files: fileList,
				intent: intent_0,
				surface: "editor",
				caret: {
					line: editorView.state.doc.lineAt(selection.from).number,
					lineCount: editorView.state.doc.lines,
					from: selection.from,
					to: selection.to
				}
			}, {
				repo,
				workspaceId: block.peek()?.workspaceId ?? repo.activeWorkspaceId ?? ""
			});
			if (!resolved) return;
			if (!editorRef.current?.view) return;
			const { decision, text: pasteText } = resolved;
			const insertAt = editorView.state.selection.main;
			if (decision.kind === "single-block") {
				const plan = planSingleBlockPaste(pasteText, {
					from: insertAt.from,
					to: insertAt.to
				});
				editorView.dispatch({
					changes: {
						from: plan.from,
						to: plan.to,
						insert: plan.insert
					},
					selection: EditorSelection.cursor(plan.cursor)
				});
				return;
			}
			const plan_0 = planEditModeMultilinePaste(pasteText, editorView.state.doc.toString(), {
				from: insertAt.from,
				to: insertAt.to
			});
			if (!plan_0) return;
			editorView.dispatch({
				changes: {
					from: 0,
					to: editorView.state.doc.length,
					insert: plan_0.targetContent
				},
				selection: EditorSelection.cursor(plan_0.focusOffsetInTarget)
			});
			const result = await pasteEditModeMultilineText(plan_0, block, repo, { scopeRootId: blockContext.scopeRootId });
			const renderScopeId = typeof blockContext.renderScopeId === "string" ? blockContext.renderScopeId : void 0;
			if (!result) return;
			await uiStateBlock.set(editorSelection, {
				blockId: result.focusBlock.id,
				start: result.focusOffset
			});
			focusBlock(uiStateBlock, result.focusBlock.id, {
				edit: true,
				renderScopeId
			});
		};
		$[5] = block;
		$[6] = blockContext;
		$[7] = repo;
		$[8] = runtime;
		$[9] = uiStateBlock;
		$[10] = t3;
	} else t3 = $[10];
	const handlePaste = t3;
	let t4;
	if ($[11] === Symbol.for("react.memo_cache_sentinel")) {
		t4 = {
			closeBrackets: true,
			lineNumbers: false,
			foldGutter: false,
			dropCursor: false,
			allowMultipleSelections: false,
			indentOnInput: false,
			highlightSelectionMatches: false,
			searchKeymap: false,
			defaultKeymap: false,
			history: false,
			historyKeymap: false,
			highlightActiveLine: false,
			completionKeymap: false
		};
		$[11] = t4;
	} else t4 = $[11];
	let t5;
	if ($[12] !== block || $[13] !== extensions || $[14] !== handlePaste) {
		t5 = /* @__PURE__ */ jsx(BlockEditor, {
			ref: editorRef,
			block,
			extensions,
			className: "min-h-[1.7em]",
			basicSetup: t4,
			indentWithTab: false,
			onKeyDownCapture: handleKeyDownCapture,
			onPasteCapture: handlePaste
		});
		$[12] = block;
		$[13] = extensions;
		$[14] = handlePaste;
		$[15] = t5;
	} else t5 = $[15];
	return t5;
}
//#endregion
export { CodeMirrorContentRenderer };

//# sourceMappingURL=CodeMirrorContentRenderer.js.map