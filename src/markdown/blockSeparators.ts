import type { ElementContent, Nodes, Root, RootContent } from 'hast'
import { visit } from 'unist-util-visit'

type Child = RootContent | ElementContent

/** Tags `mdast-util-to-hast` can emit as a container's BLOCK children — the
 *  only positions where it pretty-prints, and so the test for whether a break
 *  is its own. A remark plugin that splits a text node leaves unpositioned
 *  slices too, but among INLINE siblings; reading those as layout deletes
 *  authored text. An unknown tag therefore falls on the inline side, where a
 *  stray blank line is cosmetic and a deletion is not. */
const BLOCK_TAGS = new Set([
  'blockquote', 'div', 'dl', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
  'hr', 'li', 'ol', 'p', 'pre', 'table', 'ul',
])

const isBlock = (node: Child | undefined) =>
  node?.type === 'element' && BLOCK_TAGS.has(node.tagName)

/** A line break the serializer inserted between block children.
 *
 *  Only the block-neighbour test is load-bearing; the position and line-break
 *  tests are DEFENCE IN DEPTH, kept because the predicate is asymmetric — a
 *  false positive deletes text someone typed, a false negative leaves a blank
 *  line. They also say directly what makes a break the serializer's: authored
 *  whitespace carries a position, and a plugin's own synthesized whitespace is
 *  a space rather than a break. */
const isSerializerBreak = (node: Child, before: Child | undefined, after: Child | undefined) =>
  node.type === 'text' && !node.position &&
  node.value.trim() === '' && node.value.includes('\n') &&
  (isBlock(before) || isBlock(after))

/** The source lines a node covers — its own span, or its descendants' when
 *  the node itself was generated around authored content (mdast-to-hast wraps
 *  footnote definitions in a `<section>` of its own making). */
const spanOf = (node: Child | undefined): {start: number, end: number} | undefined => {
  if (!node) return undefined
  if (node.position) return {start: node.position.start.line, end: node.position.end.line}

  const spans = 'children' in node
    ? node.children.map(spanOf).filter(span => span !== undefined)
    : []

  return spans.length === 0
    ? undefined
    : {start: Math.min(...spans.map(s => s.start)), end: Math.max(...spans.map(s => s.end))}
}

/** Whether the source had a blank line between these two nodes. Nodes with no
 *  span anywhere beneath them are wholly synthesized and report none.
 *
 *  A node the serializer MOVED reports a span from before its new neighbour
 *  (a footnote definition written above its reference is emitted below it),
 *  so there is no authored boundary here to read and the break goes. Accepted
 *  rather than guessed at: the question is ill-posed, and the cost is one
 *  blank line above a footnote list. */
const blankLineBetween = (before: Child | undefined, after: Child | undefined) => {
  const from = spanOf(before)
  const to = spanOf(after)

  return from !== undefined && to !== undefined && to.start - from.end > 1
}

const keptChildren = <T extends Child>(children: T[]): T[] =>
  children.filter((child, index) => {
    const before = children[index - 1]
    const after = children[index + 1]

    return !isSerializerBreak(child, before, after) || blankLineBetween(before, after)
  })

/** `mdast-util-to-hast` pretty-prints, separating a container's block children
 *  with `"\n"` text nodes of its own. Content renders with `white-space:
 *  pre-wrap`, so each one draws a real blank line — around a quote, between
 *  list rows.
 *
 *  Drop the serializer's, keep the author's, and keep those two questions
 *  apart: WHICH breaks are the serializer's is structural, WHETHER a blank
 *  line belongs is answered by the source positions. Never infer the second
 *  from the tags either side — intent is in the source, not in what happens
 *  to sit around it.
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
