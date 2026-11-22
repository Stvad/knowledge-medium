/** Literal-text checks for editor autocompletes. The char triggers
 *  (`#` types, `@` contributors, `@@` places) match on raw line text, so
 *  without this check they fire inside text that is literal syntax, not
 *  prose — and with the dropdown open, Enter accepts the auto-selected
 *  completion and eats that text. Kept beside
 *  triggerMatch.ts (not in it: that module is deliberately import-free
 *  so its tests stay in the cheap node environment). */

import { Facet, type EditorState } from '@codemirror/state'
import { syntaxTree } from '@codemirror/language'
import type { SyntaxNode } from '@lezer/common'

/** @lezer/markdown node names whose text is literal, never prose:
 *  code — FencedCode (```), CodeBlock (indented), InlineCode
 *  (backticks), CodeText (the content node of the block forms);
 *  URL — autolinks and link targets (`http://…/#anchor`, `[t](#anchor)`
 *  are anchors, not tags); raw HTML, comments, and entities
 *  (`<div>#foo`, `<!-- #todo`, `&#123;`). */
const LITERAL_NODE_NAMES: ReadonlySet<string> = new Set([
  'FencedCode',
  'CodeBlock',
  'InlineCode',
  'CodeText',
  'URL',
  'HTMLBlock',
  'HTMLTag',
  'Comment',
  'CommentBlock',
  'Entity',
])

/** The whole document is literal text: an editor whose block another
 *  plugin reads as its own syntax (a table's query) contributes `true`. */
export const literalDocument = Facet.define<boolean, boolean>({combine: values => values.some(Boolean)})

/** True when `pos` sits in literal text: a `literalDocument`, or a literal
 *  markdown span (code, URL, raw HTML, comment). Fail-open: if the tree hasn't been parsed up to
 *  `pos` yet (resolve lands on the top node), the trigger stays
 *  allowed — a rare transient dropdown beats suppressing completions
 *  while the parser catches up. */
export const isLiteralTextAt = (state: EditorState, pos: number): boolean => {
  if (state.facet(literalDocument)) return true
  for (
    let node: SyntaxNode | null = syntaxTree(state).resolveInner(pos, -1);
    node;
    node = node.parent
  ) {
    if (LITERAL_NODE_NAMES.has(node.name)) return true
  }
  return false
}
