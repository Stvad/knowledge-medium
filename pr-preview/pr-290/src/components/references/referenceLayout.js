import { ReferenceLink } from "./ReferenceLink.js";
import { c } from "react/compiler-runtime";
import { jsx } from "react/jsx-runtime";
//#region src/components/references/referenceLayout.tsx
/**
* Layout for a block rendered as an inline reference (`((id))`). A reference
* IS the same block, rendered with a layout that picks the *raw content* —
* raw-content-as-an-inline-citation is the semantics of a reference. The
* navigating link wraps `RawContent` (the block's base read renderer, inline
* and chrome-free), so a media block's image, a text block's markdown, etc.
* all render through the one block-rendering pipeline.
*
* Crucially the reference layout renders NEITHER the editable content surface
* (`Content`) NOR `Children` — only the inline raw content. It therefore
* attaches no shell/paste/gesture handlers and can never become an editor.
*
* KNOWN LIMITATION: `RawContent` renders the block's content renderer as-is.
* `MarkdownContentRenderer` honours `inline` (drops to a span); a content
* renderer with NO inline form renders its full UI inside the citation link.
* This is not only the video player — every editor-style content renderer
* (block-type / property-schema / types-page editors with their inputs and
* pickers, the CodeMirror extension viewer) does too, i.e. form controls nested
* in an `<a>` (invalid HTML; a click may navigate instead of edit). It's the
* accepted "content renders wherever raw content lands" consequence — fixing it
* would need a render-mode distinction, deliberately out of scope. Common refs
* (plain text, image) are fine.
*/
var ReferenceLayout = (t0) => {
	const $ = c(5);
	const { block, RawContent } = t0;
	let t1;
	if ($[0] !== RawContent) {
		t1 = /* @__PURE__ */ jsx(RawContent, {});
		$[0] = RawContent;
		$[1] = t1;
	} else t1 = $[1];
	let t2;
	if ($[2] !== block || $[3] !== t1) {
		t2 = /* @__PURE__ */ jsx(ReferenceLink, {
			block,
			children: t1
		});
		$[2] = block;
		$[3] = t1;
		$[4] = t2;
	} else t2 = $[4];
	return t2;
};
/**
* Self-gates on `isReference` (set by `BlockRef` via `NestedBlockContextProvider`).
* The layout renders no `Children`, but `RawContent` is the block's markdown,
* which CAN contain a nested `!((id))` embed; that embed clears `isReference`
* (see `BlockEmbed`), so it renders as an embed rather than inheriting this
* layout. A nested `((id))` reference sets `isReference` itself, which is correct.
*/
var referenceLayoutContribution = (ctx) => {
	if (!ctx.blockContext?.isReference) return null;
	return {
		id: "references.reference",
		label: "Block reference",
		render: ReferenceLayout
	};
};
//#endregion
export { referenceLayoutContribution };

//# sourceMappingURL=referenceLayout.js.map