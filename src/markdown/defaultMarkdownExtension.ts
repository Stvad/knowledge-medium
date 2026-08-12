import type { MarkdownExtension } from '@/markdown/extensions.js'
import { MarkdownImage } from '@/markdown/MarkdownImage.js'
import { Children, createElement, type ReactNode } from 'react'
import type { Components } from 'react-markdown'
import remarkGfm from 'remark-gfm'

const ABSOLUTE_URL_PATTERN = /^[a-z][a-z\d+.-]*:/i

const currentLocationHref = () =>
  typeof window === 'undefined' ? undefined : window.location.href

export const isExternalHref = (
  href: string | undefined,
  baseHref = currentLocationHref(),
) => {
  if (!href) return false
  const isAbsoluteLike = ABSOLUTE_URL_PATTERN.test(href) || href.startsWith('//')
  if (!isAbsoluteLike) return false

  try {
    const url = new URL(href, baseHref)
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return false
    if (!baseHref) return true

    return url.origin !== new URL(baseHref).origin
  } catch {
    return false
  }
}

const withExternalRel = (rel: string | undefined) => {
  const values = new Set(rel?.split(/\s+/).filter(Boolean) ?? [])
  values.add('noopener')
  values.add('noreferrer')
  return [...values].join(' ')
}

type AnchorComponent = NonNullable<Components['a']>

const MarkdownAnchor: AnchorComponent = ({href, children, rel, node: _node, ...props}) => {
  const external = isExternalHref(href)
  void _node

  return createElement('a', {
    ...props,
    href,
    rel: external ? withExternalRel(rel) : rel,
    target: external ? '_blank' : props.target,
  }, children)
}

type BlockquoteComponent = NonNullable<Components['blockquote']>

const isWhitespaceText = (child: ReactNode) =>
  typeof child === 'string' && child.trim() === ''

/** Drop the whitespace-only children at each END of a list, keeping the ones
 *  between siblings. */
const trimBoundaryWhitespace = (children: ReactNode): ReactNode[] => {
  const nodes = Children.toArray(children)
  let start = 0
  let end = nodes.length
  while (start < end && isWhitespaceText(nodes[start])) start += 1
  while (end > start && isWhitespaceText(nodes[end - 1])) end -= 1

  return nodes.slice(start, end)
}

/** `mdast-util-to-hast` separates a container's block children with literal
 *  `"\n"` text nodes (`<blockquote>\n<p>quote</p>\n</blockquote>`). Harmless
 *  under normal white-space collapsing, but a block's content renders with
 *  `white-space: pre-wrap` — a block's own soft newlines are meaningful — so
 *  each separator comes out as a real blank line. The two at the quote's edges
 *  pad it with an empty line above and below, which is the whole reason a
 *  quote looked like a box; those go.
 *
 *  The INTERIOR ones stay. Preflight zeroes paragraph margins, so that newline
 *  is what puts a blank line between two quoted paragraphs — and it is the
 *  same mechanism that spaces a block's own top-level paragraphs, which render
 *  as `<p>first</p>\n<p>second</p>`. Dropping it would make a paragraph break
 *  inside a quote — and only inside a quote — indistinguishable from a soft
 *  line break. */
const MarkdownBlockquote: BlockquoteComponent = ({children, node: _node, ...props}) => {
  void _node

  return createElement('blockquote', props, trimBoundaryWhitespace(children as ReactNode))
}

export const gfmMarkdownExtension: MarkdownExtension = () => ({
  remarkPlugins: [remarkGfm],
  components: {
    a: MarkdownAnchor,
    blockquote: MarkdownBlockquote,
    img: MarkdownImage,
  },
})
