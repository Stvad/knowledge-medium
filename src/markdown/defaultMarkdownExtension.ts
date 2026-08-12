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

/** `mdast-util-to-hast` separates a container's block children with literal
 *  `"\n"` text nodes (`<blockquote>\n<p>quote</p>\n</blockquote>`). Harmless
 *  under normal white-space collapsing, but a block's content renders with
 *  `white-space: pre-wrap` — a block's own soft newlines are meaningful — so
 *  each separator comes out as a real blank line, padding the quote with a
 *  line of empty space above and below. Every child that carries content is an
 *  element, so dropping the whitespace-only strings loses nothing: text the
 *  user typed lives inside the paragraph, where pre-wrap still applies. */
const MarkdownBlockquote: BlockquoteComponent = ({children, node: _node, ...props}) => {
  void _node
  const content = Children.toArray(children as ReactNode)
    .filter(child => typeof child !== 'string' || child.trim() !== '')

  return createElement('blockquote', props, content)
}

export const gfmMarkdownExtension: MarkdownExtension = () => ({
  remarkPlugins: [remarkGfm],
  components: {
    a: MarkdownAnchor,
    blockquote: MarkdownBlockquote,
    img: MarkdownImage,
  },
})
