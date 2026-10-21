import type { MarkdownExtension } from '@/markdown/extensions.js'
import { MarkdownImage } from '@/markdown/MarkdownImage.js'
import { rehypeTrimBlockSeparators } from '@/markdown/blockSeparators.js'
import { createElement } from 'react'
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

/** Marks the lists MARKDOWN produced, so their styling can be written without
 *  a descendant selector. A `components` override only ever sees elements from
 *  the markdown AST, so the mark cannot reach a React component rendered
 *  inside the same container — an embedded block's own chrome list, say, which
 *  `.markdown-content ul` could not tell apart. Merges rather than replaces:
 *  remark-gfm marks a task list on the same element. */
const MARKDOWN_LIST_CLASS = 'markdown-list'

const withListClass = (className: string | undefined) =>
  [className, MARKDOWN_LIST_CLASS].filter(Boolean).join(' ')

const MarkdownUnorderedList: NonNullable<Components['ul']> = (
  {node: _node, className, children, ...props},
) => {
  void _node

  return createElement('ul', {...props, className: withListClass(className)}, children)
}

const MarkdownOrderedList: NonNullable<Components['ol']> = (
  {node: _node, className, children, ...props},
) => {
  void _node

  return createElement('ol', {...props, className: withListClass(className)}, children)
}

export const gfmMarkdownExtension: MarkdownExtension = () => ({
  remarkPlugins: [remarkGfm],
  rehypePlugins: [rehypeTrimBlockSeparators],
  components: {
    a: MarkdownAnchor,
    img: MarkdownImage,
    ol: MarkdownOrderedList,
    ul: MarkdownUnorderedList,
  },
})
