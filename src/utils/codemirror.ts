import { EditorSelection, type EditorState, type Extension, type SelectionRange, type StateCommand } from '@codemirror/state'
import { EditorView, keymap, type KeyBinding } from '@codemirror/view'
import { markdown, markdownLanguage } from '@codemirror/lang-markdown'
import { javascript } from '@codemirror/lang-javascript'

/** Produce the change/range spec for one selection range that either
 *  inserts an empty `open`/`close` pair at the cursor or wraps the
 *  selection with them, keeping the selection inside the wrappers.
 *  Shared by the markdown formatting commands (bold/italic/etc.) and
 *  the mobile toolbar's page-ref / block-ref completion triggers. */
export const wrapRangeWithPair = (
  state: EditorState,
  range: SelectionRange,
  open: string,
  close: string = open,
) => {
  if (range.empty) {
    return {
      changes: {from: range.from, insert: `${open}${close}`},
      range: EditorSelection.cursor(range.from + open.length),
    }
  }

  const selectedText = state.sliceDoc(range.from, range.to)
  return {
    changes: {from: range.from, to: range.to, insert: `${open}${selectedText}${close}`},
    range: EditorSelection.range(range.from + open.length, range.to + open.length),
  }
}

const markdownInlineFormatCommand = (open: string, close = open): StateCommand =>
  ({state, dispatch}) => {
    const transaction = state.changeByRange(range => {
      if (range.empty) {
        const isBetweenMarkers =
          range.from >= open.length &&
          range.to + close.length <= state.doc.length &&
          state.sliceDoc(range.from - open.length, range.from) === open &&
          state.sliceDoc(range.to, range.to + close.length) === close

        if (isBetweenMarkers) {
          return {
            changes: [
              {from: range.from - open.length, to: range.from},
              {from: range.to, to: range.to + close.length},
            ],
            range: EditorSelection.cursor(range.from - open.length),
          }
        }

        return wrapRangeWithPair(state, range, open, close)
      }

      const selectedText = state.sliceDoc(range.from, range.to)
      const isWrappedSelection =
        selectedText.startsWith(open) &&
        selectedText.endsWith(close) &&
        selectedText.length >= open.length + close.length

      if (isWrappedSelection) {
        const unwrappedText = selectedText.slice(open.length, selectedText.length - close.length)
        return {
          changes: {from: range.from, to: range.to, insert: unwrappedText},
          range: EditorSelection.range(range.from, range.from + unwrappedText.length),
        }
      }

      const beforeSelection = range.from - open.length
      const afterSelection = range.to + close.length
      const isSurroundedByMarkers =
        beforeSelection >= 0 &&
        afterSelection <= state.doc.length &&
        state.sliceDoc(beforeSelection, range.from) === open &&
        state.sliceDoc(range.to, afterSelection) === close

      if (isSurroundedByMarkers) {
        return {
          changes: [
            {from: beforeSelection, to: range.from},
            {from: range.to, to: afterSelection},
          ],
          range: EditorSelection.range(beforeSelection, range.to - open.length),
        }
      }

      return wrapRangeWithPair(state, range, open, close)
    })

    dispatch(state.update(transaction))
    return true
  }

export const toggleMarkdownBold = markdownInlineFormatCommand('**')
export const toggleMarkdownItalic = markdownInlineFormatCommand('*')
export const toggleMarkdownInlineCode = markdownInlineFormatCommand('`')
export const toggleMarkdownStrikethrough = markdownInlineFormatCommand('~~')

const markdownFormattingBinding = (key: string, run: StateCommand): KeyBinding => ({
  key,
  run,
  stopPropagation: true,
})

export const markdownFormattingKeymap: readonly KeyBinding[] = [
  markdownFormattingBinding('Mod-b', toggleMarkdownBold),
  markdownFormattingBinding('Mod-i', toggleMarkdownItalic),
  markdownFormattingBinding('Mod-e', toggleMarkdownInlineCode),
  markdownFormattingBinding('Mod-Shift-x', toggleMarkdownStrikethrough),
]

const mdNoQuoteClose = markdownLanguage.data.of({
  closeBrackets: {
    brackets: ["(", "[", "{", "`", "<"],   // drop "'" and '"'
  //   plausibly want do do "before anything?"
  }
});

export const createMinimalMarkdownConfig = (
  pluginExtensions: readonly Extension[] = [],
): Extension[] => {
  const extensions = [
    markdown({addKeymap: false, base: markdownLanguage}),
    keymap.of(markdownFormattingKeymap),
    mdNoQuoteClose,
    EditorView.theme({
      '&': {
        // Default CodeMirror styles paint the editor white; setting
        // every typographic property to `inherit` and background to
        // transparent lets the editor blend with the surrounding
        // block, so the active palette (including the selection /
        // focus tints on the parent) shows through cleanly.
        fontSize: 'inherit',
        fontFamily: 'inherit',
        color: 'inherit',
        background: 'transparent',
        lineHeight: 'inherit',
        outline: 'none',
      },
      '&.cm-focused': {outline: 'none'},
      ".cm-scroller": {
        fontFamily: "inherit",
        fontSize: "inherit",
        color: "inherit",
        lineHeight: "inherit",
      },
      '.cm-editor': {outline: 'none'},
      '.cm-focused': {outline: 'none'},
      '.cm-content': {padding: '0'},
      '.cm-line': {padding: '0'},
      /* Caret fix: remove the half-pixel shift */
      ".cm-cursor": {
        marginLeft: "0px",
      },
    }),
    EditorView.lineWrapping,
  ]

  extensions.push(...pluginExtensions)

  return extensions
}

export const createTypeScriptConfig = (): Extension[] => [
  javascript({jsx: true, typescript: true}),
  EditorView.theme({
    '&': {background: 'transparent', color: 'inherit'},
    '.cm-editor': {border: '1px solid hsl(var(--border))', borderRadius: '4px'},
    '.cm-content': {padding: '8px'},
  }),
]

/**
 * These are only a little bit cursed rn, other options for doing this seem more cursed.
 * Basic idea is we're trying to move selection to next or prev line in wrap aware fashion, and
 * if we end up at 0/doc length - we're in the first/last visual line
 */
export function isOnFirstVisualLine(view: EditorView): boolean {
  const selection = view.state.selection.main;           // active range
  const firstVis = view.moveToLineBoundary(selection, false, /*includeWrap*/ true).head;
  return firstVis === 0;
}

export function isOnLastVisualLine(view: EditorView): boolean {
  const selection = view.state.selection.main;
  const lastVis = view.moveToLineBoundary(selection, true, /*includeWrap*/ true).head
  return lastVis === view.state.doc.length;
}

export function getVisualColumn(view: EditorView): number {
  const selection = view.state.selection.main                  // active cursor
  const visualStart = view.moveToLineBoundary(selection, false, true).head
  return selection.head - visualStart                          // code-units from wrap start
}

export const placeCursorAtCoords = (view: EditorView, coords: {x: number, y: number}) => {
  const pos = view.posAtCoords(coords)      // number | null
  if (pos != null) {
    view.dispatch({selection: {anchor: pos}})
  }
}

export function placeCursorAtX(view: EditorView, x: number, takeBottomLine = false) {
  // Find a y just inside the editor
  const rect = view.dom.getBoundingClientRect()
  const y = takeBottomLine ? rect.bottom - 2 : rect.top + 2

  // Translate coords → doc position
  placeCursorAtCoords(view, {x, y})
}

export const getCaretRect = (editorView: EditorView) => {
  const {head} = editorView.state.selection.main
  return editorView.coordsAtPos(head)
}

export const cursorIsAtEnd = (editorView: EditorView) =>
  editorView.state.selection.main.head === editorView.state.doc.length

export const cursorIsAtStart = (editorView: EditorView) =>
  editorView.state.selection.main.head === 0
