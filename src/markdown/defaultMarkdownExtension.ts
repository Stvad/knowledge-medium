import type { MarkdownExtension } from '@/markdown/extensions.ts'
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

export const gfmMarkdownExtension: MarkdownExtension = () => ({
  remarkPlugins: [remarkGfm],
  components: {
    a: MarkdownAnchor,
  },
})
