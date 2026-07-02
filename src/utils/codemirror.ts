import { EditorSelection, type EditorState, type Extension, type SelectionRange, type StateCommand } from '@codemirror/state'
import { EditorView, keymap, type KeyBinding } from '@codemirror/view'
import { markdown, markdownLanguage } from '@codemirror/lang-markdown'
import { javascript } from '@codemirror/lang-javascript'
import { insertNewline } from '@codemirror/commands'

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
      // A non-empty selection that itself contains the markers (e.g. the whole
      // `**bold**` is selected) — unwrap the inner pair. Checked before the
      // surrounded-by-markers case below so that selecting the inner `*a*` of a
      // nested `**a**` unwraps the inner pair rather than stripping the outer.
      if (!range.empty) {
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
      }

      // Markers sit immediately OUTSIDE the range — strip them. Handles both the
      // empty cursor-between-markers case and the non-empty surrounded case: for
      // an empty range `EditorSelection.range(x, x)` collapses to a cursor at x.
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

// The block editor (CodeMirrorContentRenderer) disables CM's defaultKeymap and
// binds no Enter/Shift-Enter handler in CM itself, so both Enter variants would
// otherwise be produced by the browser's native `beforeinput`. We take both
// over here because `preventDefault` on `beforeinput` IS honoured on iOS (unlike
// on keydown, which iOS silently ignores for these keys — verified on-device):
//
//   • Shift+Enter → `insertLineBreak`: one soft line break inside the block.
//     iOS WebKit applies the native break TWICE in a contentEditable (CM then
//     observes "\n\n") while desktop applies it once — the iPad double-newline
//     bug. Insert exactly one break ourselves and preventDefault so no engine
//     can double it.
//
//   • Plain Enter → `insertParagraph`: a block split or completion-accept, never
//     a literal newline in this single-line editor. The behaviour is driven from
//     the keydown layer — the `split_block_cm` Enter shortcut, which accepts an
//     open autocomplete popup instead of splitting. But that shortcut's own
//     keydown `preventDefault` is ignored on iOS, so without intercepting here
//     the native paragraph still lands: it (a) leaves a stray newline and, worse,
//     (b) mutates the doc, which closes an open `[[ ]]` / `(( ))` completion
//     BEFORE the shortcut's completion-aware guard runs — so Enter splits the
//     block instead of accepting the completion. Prevent it (doc untouched, the
//     popup stays alive for the guard); we deliberately do NOT accept the
//     completion here, keeping a single accept path so we can't both accept and
//     split for one press.
//
//     Scope: this popup-stays-alive reasoning is iOS-Safari-specific, where
//     `preventDefault` on beforeinput actually cancels the native paragraph. On
//     Chromium (incl. Android soft keyboards / GBoard) beforeinput
//     `preventDefault` is a NO-OP (see CM's own note in @codemirror/view's
//     beforeinput handler), so the native "\n" still lands, closes the popup, and
//     the block still splits on a soft-keyboard Return mid-completion. That
//     Android gap is pre-existing and NOT addressed here — fixing it needs the
//     accept to happen synchronously in this handler, which reopens the
//     double-fire problem on iOS. `preventDefault` here is still harmless on
//     Chromium (the `return true` only suppresses CM's built-in beforeinput for
//     insertParagraph, whose Android Enter synthesis is covered by the observed
//     DOM-mutation path), and on desktop the branch is inert because the shortcut
//     preventDefaults the keydown before any beforeinput fires.
export const softLineBreakOnBeforeInput = EditorView.domEventHandlers({
  beforeinput(event, view) {
    if (event.inputType === 'insertParagraph') {
      event.preventDefault()
      return true
    }
    if (event.inputType !== 'insertLineBreak') return false
    if (view.state.readOnly) return false // insertNewline has no read-only guard of its own
    insertNewline(view)
    event.preventDefault()
    return true
  },
})

export const createMinimalMarkdownConfig = (
  pluginExtensions: readonly Extension[] = [],
): Extension[] => {
  const extensions = [
    markdown({addKeymap: false, base: markdownLanguage}),
    keymap.of(markdownFormattingKeymap),
    softLineBreakOnBeforeInput,
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
        // Each block is its own auto-height editor that must never scroll
        // internally — the surrounding page is the only scroll container.
        // CodeMirror's base theme makes `.cm-scroller` `overflow: auto`, and
        // the selection layer reports a few px of phantom scrollHeight beyond
        // the content (the touch selection handles past the last line). On iOS
        // WebKit, dragging a multi-line selection through the last line fires a
        // native scroll-to-selection that scrolls the editor into that phantom
        // gap and leaves `scrollTop` stuck > 0 — the whole block's text appears
        // to shift up by those few px. `clip` makes the scroller a non-scroll
        // container (so scroll-to-selection can't move it) and clips the
        // overhang. Verified on-device (iPad, iOS 26): the shift is gone.
        overflow: "clip",
      },
      '.cm-editor': {outline: 'none'},
      '.cm-focused': {outline: 'none'},
      '.cm-content': {
        padding: '0',
        // CodeMirror's base theme sets caret-color to transparent and
        // relies on the drawSelection extension's painted cursor. We
        // opt out of @uiw/react-codemirror's bundled `light` theme via
        // theme="none", so neither path supplies a visible color on
        // dark palettes. Point both at currentColor (inherited from
        // the surrounding text) so the caret tracks the active theme.
        caretColor: 'currentColor',
      },
      '.cm-line': {padding: '0'},
      /* Caret fix: zero the half-pixel shift, and recolor the drawn
         cursor (default is black) so it's visible against any palette. */
      ".cm-cursor, .cm-dropCursor": {
        marginLeft: "0px",
        borderLeftColor: "currentColor",
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
    // Wrapping (below) means no horizontal scroll, so the scroller can be a
    // non-scroll container — same as the markdown block editor. This also
    // avoids the iOS multi-line-selection scroll-shift (see the `.cm-scroller`
    // note in createMinimalMarkdownConfig).
    '.cm-scroller': {overflow: 'clip'},
  }),
  // Wrap long code lines instead of scrolling horizontally — in a narrow
  // outliner column, off-screen horizontal scroll hides content.
  EditorView.lineWrapping,
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
