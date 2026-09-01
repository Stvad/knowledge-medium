import type { Element, Root, RootContent } from 'hast'
import { visit } from 'unist-util-visit'

/** Block-level tags `mdast-util-to-hast` can emit as a container's children. */
const BLOCK_TAGS = new Set([
  'blockquote', 'div', 'dl', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
  'hr', 'li', 'ol', 'p', 'pre', 'table', 'ul',
])

/** …minus the list row, which already starts its own line. A blank line
 *  between rows is what made every list render double-spaced. */
const SPACED_BLOCK_TAGS = new Set([...BLOCK_TAGS].filter(tag => tag !== 'li'))

const tagIn = (node: RootContent | undefined, tags: ReadonlySet<string>) =>
  node?.type === 'element' && tags.has(node.tagName)

/** `mdast-util-to-hast` pretty-prints, separating a container's block children
 *  with literal `"\n"` text nodes. Content renders with `white-space:
 *  pre-wrap`, so each one draws a real blank line.
 *
 *  Keep a separator only between two blocks that want a blank line between
 *  them (preflight zeroes their margins, so this newline is the only thing
 *  drawing it); drop it at a container's edges, between list rows, and beside
 *  a row's own inline content.
 *
 *  Recognise one by POSITION, never by content: the pretty-printer emits
 *  exactly `"\n"`, which is also how an authored soft line break is spelled,
 *  so only a block-level neighbour tells the two apart — a content-only rule
 *  eats the space in `- **bold** *italic*`.
 *
 *  Root is left alone (`visit` reaches elements only, and root is not one):
 *  its separators space a block's own top-level blocks. */
export const rehypeTrimBlockSeparators = () => (tree: Root) => {
  visit(tree, 'element', (node: Element) => {
    node.children = node.children.filter((child, index) => {
      if (child.type !== 'text' || child.value.trim() !== '') return true

      const before = node.children[index - 1]
      const after = node.children[index + 1]
      if (!tagIn(before, BLOCK_TAGS) && !tagIn(after, BLOCK_TAGS)) return true

      return tagIn(before, SPACED_BLOCK_TAGS) && tagIn(after, SPACED_BLOCK_TAGS)
    })
  })
}
