import type { ElementContent, Nodes, Root, RootContent } from 'hast'
import { visit } from 'unist-util-visit'

type Child = RootContent | ElementContent

/** Tags `mdast-util-to-hast` can emit as a container's BLOCK children — the
 *  only positions where it pretty-prints. Nothing here judges whether a blank
 *  line is WANTED; the source positions answer that. This says only where the
 *  serializer's own line breaks can occur, which is what tells them apart from
 *  a remark plugin's: a plugin that splits a text node (`remark-blockrefs`,
 *  `remark-timestamps`) leaves unpositioned slices too, but among INLINE
 *  siblings, and deleting the newline between two refs on adjacent lines runs
 *  them together. An unknown tag falls on the inline side, where a stray blank
 *  line is cosmetic and a deletion is not. */
const BLOCK_TAGS = new Set([
  'blockquote', 'div', 'dl', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
  'hr', 'li', 'ol', 'p', 'pre', 'table', 'ul',
])

const isBlock = (node: Child | undefined) =>
  node?.type === 'element' && BLOCK_TAGS.has(node.tagName)

/** A line break the serializer inserted between block children.
 *
 *  The block-neighbour test is the one carrying this; the other two are
 *  DEFENCE IN DEPTH — delete either and nothing through the public path
 *  changes, because the parser emits no whitespace-only node that is both
 *  adjacent to a block and authored. They stay because the predicate is
 *  asymmetric: a false positive deletes text someone typed, a false negative
 *  leaves a blank line. And they say directly what makes a break the
 *  serializer's — no source position (authored whitespace has one), and a
 *  line break rather than a space (remark-gfm's own space after a task
 *  checkbox is unpositioned too, and is content). The position clause is
 *  pinned by a unit test on a hand-built tree, no markdown input producing
 *  the shape; the line-break clause has no such test and is redundant with
 *  the block-neighbour one today. */
const isSerializerBreak = (node: Child, before: Child | undefined, after: Child | undefined) =>
  node.type === 'text' && !node.position &&
  node.value.trim() === '' && node.value.includes('\n') &&
  (isBlock(before) || isBlock(after))

/** Whether the source had a blank line between these two nodes. A node with
 *  no position was synthesized and reports none. */
const blankLineBetween = (before: Child | undefined, after: Child | undefined) =>
  before?.position !== undefined && after?.position !== undefined &&
  after.position.start.line - before.position.end.line > 1

const keptChildren = <T extends Child>(children: T[]): T[] =>
  children.filter((child, index) => {
    const before = children[index - 1]
    const after = children[index + 1]

    return !isSerializerBreak(child, before, after) || blankLineBetween(before, after)
  })

/** `mdast-util-to-hast` pretty-prints, separating a container's block children
 *  with `"\n"` text nodes of its own. Content renders with `white-space:
 *  pre-wrap`, so each one draws a real blank line — above and below a quote,
 *  between every pair of list rows.
 *
 *  Drop the serializer's, keep the author's. The two questions stay separate,
 *  because merging them is what went wrong twice: WHICH breaks are the
 *  serializer's is structural (`isSerializerBreak`), and WHETHER a blank line
 *  belongs is answered by the source positions — never by guessing from the
 *  tags either side, which was wrong about one more pair every time it was
 *  tried (a quote after a paragraph, then the rows of a loose list).
 *
 *  Preflight zeroes block margins, so a kept break is the only thing drawing
 *  the line the author wrote. */
export const rehypeTrimBlockSeparators = () => (tree: Root) => {
  visit(tree, (node: Nodes) => {
    if (node.type === 'root' || node.type === 'element') {
      node.children = keptChildren(node.children)
    }
  })
}
