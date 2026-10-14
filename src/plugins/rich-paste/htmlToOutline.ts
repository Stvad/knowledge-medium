import { fromDom } from 'hast-util-from-dom'
import { toMdast } from 'hast-util-to-mdast'
import type { Nodes, Parents, PhrasingContent, Root, RootContent } from 'mdast'
import { gfmToMarkdown } from 'mdast-util-gfm'
import { toMarkdown, type Options as ToMarkdownOptions } from 'mdast-util-to-markdown'
import { outlineFromTokens, type OutlineNode, type OutlineToken } from '@/utils/markdownParser.js'
import { normalizeClipboardDom } from './normalizeClipboardDom.js'

export type ClipboardHtmlConversion =
  /** The HTML carries nothing the plain text lacks — paste the text as usual. */
  | {kind: 'plain'}
  /** A single line of content, as inline markdown (no heading or list marker),
   *  for the ordinary single-line paste path. */
  | {kind: 'inline'; markdown: string}
  | {kind: 'outline'; blocks: OutlineNode[]}

/** Convert clipboard `text/html` into an outline: one block per heading,
 *  paragraph, list item, table, code block or quote, nested by the shared
 *  paste structuring rules (`outlineFromTokens`), each block's content written
 *  as markdown. */
export const convertClipboardHtml = (html: string): ClipboardHtmlConversion => {
  const body = new DOMParser().parseFromString(html, 'text/html').body
  normalizeClipboardDom(body)
  const mdast = toMdast(fromDom(body)) as Root
  sanitize(mdast)
  if (!carriesStructure(mdast)) return {kind: 'plain'}

  const units: Unit[] = []
  walkFlow(mdast.children, 0, units)
  if (units.length === 0) return {kind: 'plain'}
  const [only] = units
  if (units.length === 1 && only.inline !== undefined && !only.inline.includes('\n')) {
    return {kind: 'inline', markdown: only.inline}
  }
  return {kind: 'outline', blocks: outlineFromTokens(units.map(unit => unit.token))}
}

/** A token plus, for content that can be inlined at a caret, that form. */
interface Unit {
  token: OutlineToken
  inline?: string
}

/** Whether the HTML says anything the plain text doesn't. Plain paragraphs
 *  are what the text path already produces; a lone code block is a copy from
 *  a code view (an IDE, a raw file, a terminal), whose plain text is the
 *  better source. Neither is worth taking over the paste for. */
const carriesStructure = (root: Root): boolean => {
  if (root.children.length === 1 && root.children[0].type === 'code') return false
  const hasMarkup = (node: Nodes): boolean =>
    !['root', 'paragraph', 'text', 'break'].includes(node.type) ||
    ('children' in node && node.children.some(hasMarkup))
  return hasMarkup(root)
}

const walkFlow = (nodes: readonly RootContent[], indent: number, units: Unit[]): void => {
  for (const node of nodes) {
    switch (node.type) {
      case 'heading': {
        const inline = phrasing(node.children, {singleLine: true})
        if (inline) {
          const content = `${'#'.repeat(node.depth)} ${inline}`
          units.push({token: {kind: 'heading', level: node.depth, indent, content}, inline})
        }
        break
      }
      case 'paragraph': {
        const inline = phrasing(node.children)
        if (inline) units.push({token: {kind: 'paragraph', indent, content: inline}, inline})
        break
      }
      case 'list':
        node.children.forEach((item, index) => {
          const [first, ...rest] = item.children
          const inline = first?.type === 'paragraph' ? phrasing(first.children) : ''
          if (!inline) {
            // No text of its own (e.g. an item holding only a sub-list):
            // its content nests under whatever precedes it.
            walkFlow(first?.type === 'paragraph' ? rest : item.children, indent + 1, units)
            return
          }
          // Ordered items keep their number, matching a markdown-text paste.
          const content = node.ordered ? `${(node.start ?? 1) + index}. ${inline}` : inline
          units.push({token: {kind: 'list-item', indent, content}, inline})
          walkFlow(rest, indent + 1, units)
        })
        break
      case 'code':
      case 'blockquote':
        if (hasContent(node)) units.push({token: {kind: 'atomic', indent, content: markdown(node)}})
        break
      case 'table':
        // A GFM table row can't contain a line break.
        if (hasContent(node)) units.push({token: {kind: 'atomic', indent, content: markdown(withoutBreaks(node))}})
        break
      // Thematic breaks, definitions, raw html: no block worth making.
    }
  }
}

const MARKDOWN_OPTIONS: ToMarkdownOptions = {
  extensions: [gfmToMarkdown()],
  bullet: '-',
  emphasis: '*',
  // Blocks render with `white-space: pre-wrap`, so a plain newline is a line
  // break — the same thing Shift+Enter types — where markdown's `\` hard
  // break would show its backslash in the editor.
  handlers: {break: () => '\n'},
}

const markdown = (node: Nodes): string =>
  toMarkdown(node, MARKDOWN_OPTIONS).replace(/\n+$/, '')

/** Inline markdown for phrasing content, escaped so a block that merely
 *  starts with `#`, `-` or `1.` isn't read back as a heading or list. */
const phrasing = (children: PhrasingContent[], {singleLine = false} = {}): string => {
  const paragraph = {type: 'paragraph' as const, children}
  return markdown(singleLine ? withoutBreaks(paragraph) : paragraph).trim()
}

/** Whether `node` holds any text or image — an empty table or quote would
 *  otherwise paste as a block of bare pipes or `>`. */
const hasContent = (node: Nodes): boolean => {
  if (node.type === 'image') return true
  if ('value' in node && node.value.trim() !== '') return true
  return 'children' in node && node.children.some(hasContent)
}

const withoutBreaks = <T extends Parents>(node: T): T => {
  const replace = (current: Nodes): Nodes => {
    if (current.type === 'break') return {type: 'text', value: ' '}
    if (!('children' in current)) return current
    return {...current, children: current.children.map(replace)} as Nodes
  }
  return replace(node) as T
}

/** Drop what can't work once pasted (fragment and relative links, `data:`/
 *  `blob:` images), link titles and whitespace oddities, in place. */
const sanitize = (node: Parents): void => {
  node.children = node.children.flatMap((child): Nodes[] => {
    if (child.type === 'link') {
      const href = absoluteHref(child.url)
      if (href === undefined) {
        sanitize(child)
        return child.children
      }
      child.url = href
      child.title = null // a hover tooltip on the source page; clutter in a block
    }
    if (child.type === 'image') {
      if (absoluteHref(child.url, IMAGE_PROTOCOLS) === undefined) return []
      child.title = null
    }
    if (child.type === 'text') {
      child.value = child.value.replace(/\u00a0/g, ' ').replace(/[\u200b\ufeff]/g, '')
    }
    if ('children' in child) sanitize(child)
    return [child]
  }) as typeof node.children
}

const LINK_PROTOCOLS = ['http:', 'https:', 'mailto:']
const IMAGE_PROTOCOLS = ['http:', 'https:']

/** `url` if it is absolute with an allowed protocol — unwrapping Google's
 *  `google.com/url?q=` redirect — else undefined. */
const absoluteHref = (url: string, protocols = LINK_PROTOCOLS): string | undefined => {
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return undefined // relative or a bare #fragment: nothing to point at here
  }
  if (/^(www\.)?google\.com$/.test(parsed.hostname) && parsed.pathname === '/url') {
    const target = parsed.searchParams.get('q')
    return target ? absoluteHref(target, protocols) : undefined
  }
  return protocols.includes(parsed.protocol) ? url : undefined
}
