import { Extension } from '@codemirror/state'
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
