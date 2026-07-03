import { EditorSelection } from "../../node_modules/@codemirror/state/dist/index.js";
import { EditorView, keymap } from "../../node_modules/@codemirror/view/dist/index.js";
import { markdown, markdownLanguage } from "../../node_modules/@codemirror/lang-markdown/dist/index.js";
import { javascript } from "../../node_modules/@codemirror/lang-javascript/dist/index.js";
import { insertNewline } from "../../node_modules/@codemirror/commands/dist/index.js";
//#region src/utils/codemirror.ts
/** Clamp every range of a selection into `[0, docLength]`. For
*  dispatching a REMEMBERED selection against a doc that may have
*  shrunk since it was captured — a debounce-persisted selection
*  restored on focus, or a selection carried across an external
*  content adoption. CodeMirror throws "Selection points outside of
*  document" on a raw out-of-range anchor, and (for adoption) omitting
*  the selection instead would let default mapping collapse the cursor
*  to 0. */
var clampSelectionToLength = (selection, docLength) => EditorSelection.create(selection.ranges.map((range) => EditorSelection.range(Math.max(0, Math.min(range.anchor, docLength)), Math.max(0, Math.min(range.head, docLength)))), selection.mainIndex);
/** Produce the change/range spec for one selection range that either
*  inserts an empty `open`/`close` pair at the cursor or wraps the
*  selection with them, keeping the selection inside the wrappers.
*  Shared by the markdown formatting commands (bold/italic/etc.) and
*  the mobile toolbar's page-ref / block-ref completion triggers. */
var wrapRangeWithPair = (state, range, open, close = open) => {
	if (range.empty) return {
		changes: {
			from: range.from,
			insert: `${open}${close}`
		},
		range: EditorSelection.cursor(range.from + open.length)
	};
	const selectedText = state.sliceDoc(range.from, range.to);
	return {
		changes: {
			from: range.from,
			to: range.to,
			insert: `${open}${selectedText}${close}`
		},
		range: EditorSelection.range(range.from + open.length, range.to + open.length)
	};
};
var markdownInlineFormatCommand = (open, close = open) => ({ state, dispatch }) => {
	const transaction = state.changeByRange((range) => {
		if (!range.empty) {
			const selectedText = state.sliceDoc(range.from, range.to);
			if (selectedText.startsWith(open) && selectedText.endsWith(close) && selectedText.length >= open.length + close.length) {
				const unwrappedText = selectedText.slice(open.length, selectedText.length - close.length);
				return {
					changes: {
						from: range.from,
						to: range.to,
						insert: unwrappedText
					},
					range: EditorSelection.range(range.from, range.from + unwrappedText.length)
				};
			}
		}
		const beforeSelection = range.from - open.length;
		const afterSelection = range.to + close.length;
		if (beforeSelection >= 0 && afterSelection <= state.doc.length && state.sliceDoc(beforeSelection, range.from) === open && state.sliceDoc(range.to, afterSelection) === close) return {
			changes: [{
				from: beforeSelection,
				to: range.from
			}, {
				from: range.to,
				to: afterSelection
			}],
			range: EditorSelection.range(beforeSelection, range.to - open.length)
		};
		return wrapRangeWithPair(state, range, open, close);
	});
	dispatch(state.update(transaction));
	return true;
};
var toggleMarkdownBold = markdownInlineFormatCommand("**");
var toggleMarkdownItalic = markdownInlineFormatCommand("*");
var toggleMarkdownInlineCode = markdownInlineFormatCommand("`");
var toggleMarkdownStrikethrough = markdownInlineFormatCommand("~~");
var markdownFormattingBinding = (key, run) => ({
	key,
	run,
	stopPropagation: true
});
var markdownFormattingKeymap = [
	markdownFormattingBinding("Mod-b", toggleMarkdownBold),
	markdownFormattingBinding("Mod-i", toggleMarkdownItalic),
	markdownFormattingBinding("Mod-e", toggleMarkdownInlineCode),
	markdownFormattingBinding("Mod-Shift-x", toggleMarkdownStrikethrough)
];
var mdNoQuoteClose = markdownLanguage.data.of({ closeBrackets: { brackets: [
	"(",
	"[",
	"{",
	"`",
	"<"
] } });
var softLineBreakOnBeforeInput = EditorView.domEventHandlers({ beforeinput(event, view) {
	if (event.inputType !== "insertLineBreak") return false;
	if (view.state.readOnly) return false;
	insertNewline(view);
	event.preventDefault();
	return true;
} });
var createMinimalMarkdownConfig = (pluginExtensions = []) => {
	const extensions = [
		markdown({
			addKeymap: false,
			base: markdownLanguage
		}),
		keymap.of(markdownFormattingKeymap),
		softLineBreakOnBeforeInput,
		mdNoQuoteClose,
		EditorView.theme({
			"&": {
				fontSize: "inherit",
				fontFamily: "inherit",
				color: "inherit",
				background: "transparent",
				lineHeight: "inherit",
				outline: "none"
			},
			"&.cm-focused": { outline: "none" },
			".cm-scroller": {
				fontFamily: "inherit",
				fontSize: "inherit",
				color: "inherit",
				lineHeight: "inherit",
				overflow: "clip"
			},
			".cm-editor": { outline: "none" },
			".cm-focused": { outline: "none" },
			".cm-content": {
				padding: "0",
				caretColor: "currentColor"
			},
			".cm-line": { padding: "0" },
			".cm-cursor, .cm-dropCursor": {
				marginLeft: "0px",
				borderLeftColor: "currentColor"
			}
		}),
		EditorView.lineWrapping
	];
	extensions.push(...pluginExtensions);
	return extensions;
};
var createTypeScriptConfig = () => [
	javascript({
		jsx: true,
		typescript: true
	}),
	EditorView.theme({
		"&": {
			background: "transparent",
			color: "inherit"
		},
		".cm-editor": {
			border: "1px solid hsl(var(--border))",
			borderRadius: "4px"
		},
		".cm-content": { padding: "8px" },
		".cm-scroller": { overflow: "clip" }
	}),
	EditorView.lineWrapping
];
/**
* These are only a little bit cursed rn, other options for doing this seem more cursed.
* Basic idea is we're trying to move selection to next or prev line in wrap aware fashion, and
* if we end up at 0/doc length - we're in the first/last visual line
*/
function isOnFirstVisualLine(view) {
	const selection = view.state.selection.main;
	return view.moveToLineBoundary(selection, false, true).head === 0;
}
function isOnLastVisualLine(view) {
	const selection = view.state.selection.main;
	return view.moveToLineBoundary(selection, true, true).head === view.state.doc.length;
}
function getVisualColumn(view) {
	const selection = view.state.selection.main;
	const visualStart = view.moveToLineBoundary(selection, false, true).head;
	return selection.head - visualStart;
}
var placeCursorAtCoords = (view, coords) => {
	const pos = view.posAtCoords(coords);
	if (pos != null) view.dispatch({ selection: { anchor: pos } });
};
function placeCursorAtX(view, x, takeBottomLine = false) {
	const rect = view.dom.getBoundingClientRect();
	placeCursorAtCoords(view, {
		x,
		y: takeBottomLine ? rect.bottom - 2 : rect.top + 2
	});
}
var getCaretRect = (editorView) => {
	const { head } = editorView.state.selection.main;
	return editorView.coordsAtPos(head);
};
var cursorIsAtEnd = (editorView) => editorView.state.selection.main.head === editorView.state.doc.length;
var cursorIsAtStart = (editorView) => editorView.state.selection.main.head === 0;
//#endregion
export { clampSelectionToLength, createMinimalMarkdownConfig, createTypeScriptConfig, cursorIsAtEnd, cursorIsAtStart, getCaretRect, getVisualColumn, isOnFirstVisualLine, isOnLastVisualLine, markdownFormattingKeymap, placeCursorAtCoords, placeCursorAtX, softLineBreakOnBeforeInput, toggleMarkdownBold, toggleMarkdownInlineCode, toggleMarkdownItalic, toggleMarkdownStrikethrough, wrapRangeWithPair };

//# sourceMappingURL=codemirror.js.map