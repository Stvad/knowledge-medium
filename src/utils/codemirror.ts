import { Extension, EditorState } from '@codemirror/state'
import { EditorView, keymap } from '@codemirror/view'
import { defaultKeymap, history, historyKeymap } from '@codemirror/commands'
import { markdown } from '@codemirror/lang-markdown'
import { javascript } from '@codemirror/lang-javascript'

export const createMinimalMarkdownConfig = (): Extension[] => [
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

export const createTypeScriptConfig = (): Extension[] => [
  javascript({jsx: true, typescript: true}),
  history(),
  keymap.of([...defaultKeymap, ...historyKeymap]),
  EditorView.theme({
    '.cm-editor': {border: '1px solid #ccc', borderRadius: '4px'},
    '.cm-content': {padding: '8px'},
  }),
]

export const getCurrentLine = (state: EditorState) => {
  const {head} = state.selection.main
  return state.doc.lineAt(head)
}

export const isOnFirstLine = (state: EditorState) => getCurrentLine(state).number === 1
export const isOnLastLine = (state: EditorState) => getCurrentLine(state).number === state.doc.lines


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
