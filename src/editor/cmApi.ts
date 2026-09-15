/*
  Curated CodeMirror re-exports for EXTENSION authors.

  `codeMirrorExtensionsFacet` invites extensions to contribute CodeMirror
  extensions to the block editor, but a dynamic (block-installed)
  extension currently has no way to build one that needs CM classes:

  - It can't import `@codemirror/*` — the page importmap maps only
    `react*` and `@/`, so the bare specifier doesn't resolve.
  - Bundling a private CM copy into the extension doesn't work either:
    CodeMirror validates extension values against its own classes
    (instanceof checks during extension flattening), so a ViewPlugin or
    StateField built from a second copy of @codemirror/state fails with
    "Unrecognized extension value".

  Net effect: the facet is only usable for contributions assembled
  entirely from host-built helpers — no Decorations, no StateFields.

  Importing THIS module (`@/editor/cmApi.js`) resolves through the
  importmap to the app's own CodeMirror instances, so contributed
  plugins and decorations match by identity. The list is curated rather
  than `export *`: it is the supported extension-author surface, and it
  can grow deliberately.
*/

export {
  EditorView,
  ViewPlugin,
  ViewUpdate,
  Decoration,
  WidgetType,
  keymap,
} from '@codemirror/view'
export type { DecorationSet, PluginValue } from '@codemirror/view'

export {
  EditorState,
  StateField,
  StateEffect,
  RangeSetBuilder,
  Compartment,
  Facet,
  Prec,
} from '@codemirror/state'
export type { Extension, Range } from '@codemirror/state'

export {
  syntaxTree,
  syntaxHighlighting,
  HighlightStyle,
} from '@codemirror/language'

export { tags } from '@lezer/highlight'
export type { Tag } from '@lezer/highlight'
