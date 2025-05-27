import { Extension } from '@codemirror/state'
import { EditorView } from '@codemirror/view'
import { markdown } from '@codemirror/lang-markdown'
import { javascript } from '@codemirror/lang-javascript'
import { createBacklinkAutocomplete } from './backlinkAutocomplete'

export const createMinimalMarkdownConfig = (backlinkOptions?: {
  getAliases: (filter: string) => Promise<string[]>
}): Extension[] => {
  const extensions = [
    markdown({addKeymap: false}),
    EditorView.theme({
      '&': {
        fontSize: 'inherit',
        fontFamily: 'inherit',
        color: 'inherit',
        lineHeight: 'inherit',
      },
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

  // Add backlink autocomplete if options provided
  if (backlinkOptions) {
    extensions.push(createBacklinkAutocomplete(backlinkOptions))
  }

  return extensions
}

export const createTypeScriptConfig = (): Extension[] => [
  javascript({jsx: true, typescript: true}),
  EditorView.theme({
    '.cm-editor': {border: '1px solid #ccc', borderRadius: '4px'},
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
