import type { Element, Root, RootContent } from 'hast'
import { visit } from 'unist-util-visit'

/** Flow-content tags `mdast-util-to-hast` emits as a container's block
 *  children. Everything else — including a tag this list has never heard of —
 *  counts as inline: a stray blank line is cosmetic, whereas swallowing an
 *  authored space corrupts the text. */
const BLOCK_TAGS = new Set([
  'blockquote', 'div', 'dl', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
  'hr', 'li', 'ol', 'p', 'pre', 'table', 'ul',
])

const isElement = (node: RootContent | undefined, tags: ReadonlySet<string>) =>
  node?.type === 'element' && tags.has(node.tagName)

const isBlock = (node: RootContent | undefined) => isElement(node, BLOCK_TAGS)

const isParagraph = (node: RootContent | undefined) =>
  node?.type === 'element' && node.tagName === 'p'

/** `mdast-util-to-hast` pretty-prints, separating a container's block children
 *  with literal `"\n"` text nodes (`<ul>\n<li>a</li>\n<li>b</li>\n</ul>`).
 *  Harmless under normal white-space collapsing, but a block's content renders
 *  with `white-space: pre-wrap` — a block's own soft newlines are meaningful —
 *  so each separator draws a real blank line: above and below a quote, between
 *  every pair of list items, and between an item and its nested list.
 *
 *  A separator is recognised by POSITION, never by content: the pretty-printer
 *  emits exactly `"\n"`, which is also what an authored soft line break looks
 *  like, so only a block-level neighbour distinguishes the two. That is why
 *  `- **bold** *italic*` keeps its space — the neighbours there are inline.
 *
 *  The one separator that earns its line sits BETWEEN TWO PARAGRAPHS:
 *  preflight zeroes paragraph margins, so that newline is what puts a blank
 *  line between the two paragraphs of a loose list item or a multi-paragraph
 *  quote. Dropping it would make a paragraph break inside a container
 *  indistinguishable from a soft line break.
 *
 *  The document ROOT is left alone — `visit` reaches elements only, and root
 *  is not one. Its separators are the same mechanism spacing a block's own
 *  top-level paragraphs, lists and quotes, and that spacing is wanted. */
export const rehypeTrimBlockSeparators = () => (tree: Root) => {
  visit(tree, 'element', (node: Element) => {
    node.children = node.children.filter((child, index) => {
      if (child.type !== 'text' || child.value.trim() !== '') return true

      const before = node.children[index - 1]
      const after = node.children[index + 1]
      if (!isBlock(before) && !isBlock(after)) return true

      return isParagraph(before) && isParagraph(after)
    })
  })
}
