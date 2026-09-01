import type { ElementContent, Nodes, Root, RootContent } from 'hast'
import { visit } from 'unist-util-visit'

type Child = RootContent | ElementContent

/** A line break the pretty-printer synthesized — the only whitespace in the
 *  tree that carries no meaning. Whitespace the author typed has a source
 *  position, and a plugin's own synthesized whitespace is a space rather than
 *  a break (remark-gfm puts one after a task checkbox). */
const isPrettyPrinted = (node: Child) =>
  node.type === 'text' && !node.position &&
  node.value.trim() === '' && node.value.includes('\n')

/** Whether the source had a blank line between these two nodes. A node with
 *  no position was synthesized by some other plugin and reports none. */
const blankLineBetween = (before: Child | undefined, after: Child | undefined) =>
  before?.position !== undefined && after?.position !== undefined &&
  after.position.start.line - before.position.end.line > 1

const keptChildren = <T extends Child>(children: T[]): T[] =>
  children.filter((child, index) =>
    !isPrettyPrinted(child) ||
    blankLineBetween(children[index - 1], children[index + 1]))

/** `mdast-util-to-hast` pretty-prints, separating a container's block children
 *  with `"\n"` text nodes of its own. Content renders with `white-space:
 *  pre-wrap`, so each one draws a real blank line — above and below a quote,
 *  between every pair of list rows.
 *
 *  Drop the pretty-printer's, keep the author's. Both facts are in the tree:
 *  a synthesized node has no source position, and the neighbours' spans say
 *  whether a blank line stood between them. Nothing here reasons about WHICH
 *  tags sit either side; the rule that did kept being wrong about one more
 *  pair (a quote after a paragraph, loose rows). Preflight zeroes block
 *  margins, so a kept separator is the only thing drawing that line. */
export const rehypeTrimBlockSeparators = () => (tree: Root) => {
  visit(tree, (node: Nodes) => {
    if (node.type === 'root' || node.type === 'element') {
      node.children = keptChildren(node.children)
    }
  })
}
