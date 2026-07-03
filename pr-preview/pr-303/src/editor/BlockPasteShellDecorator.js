import { focusBlock, isFocusedBlock } from "../data/properties.js";
import { useAppRuntime } from "../extensions/runtimeContext.js";
import { isInteractiveContentEvent } from "../extensions/blockInteraction.js";
import { pasteMultilineText, resolvePasteWithMediaCapture } from "../paste/operations.js";
import { c } from "react/compiler-runtime";
import { Fragment, jsx } from "react/jsx-runtime";
//#region src/editor/BlockPasteShellDecorator.tsx
/**
* Block-shell paste, as a shell decorator rather than a hardcoded handler on the
* block wrapper. Contributing `onPaste` here (instead of baking it into
* `DefaultBlockRenderer`'s shell props) puts paste on the same footing as the
* other interactions — click (`blockClickHandlersFacet`), selection/focus (their
* own shell decorators) — so it composes, can be overridden/disabled per the
* plugin toggle, and keeps the renderer out of the paste/media plumbing.
*
* Fires only on the FOCUSED block, NOT in edit mode (the editor owns paste then).
* Reads live focus at fire time via `isFocusedBlock` (peekProperty) rather than
* capturing reactive focus, so the closure stays stable.
*/
function BlockPasteShellDecorator(t0) {
	const $ = c(20);
	const { resolveContext, state, children } = t0;
	const runtime = useAppRuntime();
	const { block, repo, uiStateBlock, scopeRootId, blockContext } = resolveContext;
	const renderScopeId = typeof blockContext?.renderScopeId === "string" ? blockContext.renderScopeId : void 0;
	let t1;
	if ($[0] !== block || $[1] !== renderScopeId || $[2] !== repo || $[3] !== runtime || $[4] !== scopeRootId || $[5] !== uiStateBlock) {
		t1 = async (e) => {
			if (e.defaultPrevented || isInteractiveContentEvent(e)) return;
			if (!isFocusedBlock(uiStateBlock, block.id, renderScopeId)) return;
			e.preventDefault();
			const files = e.clipboardData.files;
			const fileList = files && files.length > 0 ? Array.from(files) : [];
			const pastedText = e.clipboardData.getData("text/plain");
			if (!pastedText && fileList.length === 0) return;
			const resolved = await resolvePasteWithMediaCapture(runtime, {
				text: pastedText,
				html: e.clipboardData.getData("text/html") || void 0,
				files: fileList,
				intent: "split",
				surface: "shell"
			}, {
				repo,
				workspaceId: block.peek()?.workspaceId ?? repo.activeWorkspaceId ?? ""
			});
			if (!resolved) return;
			const pasted = await pasteMultilineText(resolved.text, block, repo, {
				scopeRootId,
				asSingleBlock: resolved.decision.kind === "single-block"
			});
			if (pasted[0]) focusBlock(uiStateBlock, pasted[0].id, { renderScopeId });
		};
		$[0] = block;
		$[1] = renderScopeId;
		$[2] = repo;
		$[3] = runtime;
		$[4] = scopeRootId;
		$[5] = uiStateBlock;
		$[6] = t1;
	} else t1 = $[6];
	const handlePaste = t1;
	let t2;
	if ($[7] !== handlePaste) {
		t2 = (event) => {
			handlePaste(event);
		};
		$[7] = handlePaste;
		$[8] = t2;
	} else t2 = $[8];
	let t3;
	if ($[9] !== state.shellProps || $[10] !== t2) {
		t3 = {
			...state.shellProps,
			onPaste: t2
		};
		$[9] = state.shellProps;
		$[10] = t2;
		$[11] = t3;
	} else t3 = $[11];
	let t4;
	if ($[12] !== state.shortcutSurfaceOptions || $[13] !== t3) {
		t4 = {
			shellProps: t3,
			shortcutSurfaceOptions: state.shortcutSurfaceOptions
		};
		$[12] = state.shortcutSurfaceOptions;
		$[13] = t3;
		$[14] = t4;
	} else t4 = $[14];
	const nextState = t4;
	let t5;
	if ($[15] !== children || $[16] !== nextState) {
		t5 = children(nextState);
		$[15] = children;
		$[16] = nextState;
		$[17] = t5;
	} else t5 = $[17];
	let t6;
	if ($[18] !== t5) {
		t6 = /* @__PURE__ */ jsx(Fragment, { children: t5 });
		$[18] = t5;
		$[19] = t6;
	} else t6 = $[19];
	return t6;
}
var blockPasteShellDecorator = () => BlockPasteShellDecorator;
//#endregion
export { blockPasteShellDecorator };

//# sourceMappingURL=BlockPasteShellDecorator.js.map