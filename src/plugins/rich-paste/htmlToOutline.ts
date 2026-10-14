import { fromDom } from 'hast-util-from-dom'
import { toMdast } from 'hast-util-to-mdast'
import type { Nodes, Paragraph, Parents, PhrasingContent, Root, RootContent } from 'mdast'
import { gfmToMarkdown } from 'mdast-util-gfm'
import { toMarkdown, type Options as ToMarkdownOptions } from 'mdast-util-to-markdown'
import { outlineFromTokens, type OutlineNode, type OutlineToken } from '@/utils/markdownParser.js'
import { normalizeClipboardDom } from './normalizeClipboardDom.js'

export type ClipboardHtmlConversion =
  /** The plain text is the better source (an outliner's own copy), or the
   *  HTML carries nothing it lacks — paste the text as usual. Never chosen
   *  when there is no plain text to paste. */
  | {kind: 'plain'}
  /** A single line of paragraph text, as inline markdown, for the ordinary
   *  single-line paste path. A lone heading or list item is an outline: the
   *  browser only puts the element on the clipboard when the whole block was
   *  copied (a partial selection arrives as a styled span). */
  | {kind: 'inline'; markdown: string}
  | {kind: 'outline'; blocks: OutlineNode[]}

/** Convert clipboard `text/html` into an outline: one block per heading,
 *  paragraph, list item, table, code block or quote, nested by the shared
 *  paste structuring rules (`outlineFromTokens`), each block's content written
 *  as markdown. `plainText` is the same clipboard's `text/plain`. */
export const convertClipboardHtml = (html: string, plainText: string): ClipboardHtmlConversion => {
  const body = new DOMParser().parseFromString(html, 'text/html').body
  if (hasOutlinerReferences(plainText, body)) return {kind: 'plain'}
  normalizeClipboardDom(body)
  const mdast = toMdast(fromDom(body)) as Root
  sanitize(mdast)
  splitAtBlankLines(mdast)
  // With no plain text (an html-only clipboard) the html is the only source.
  if (plainText.trim() && !carriesStructure(mdast)) return {kind: 'plain'}

  const tokens: OutlineToken[] = []
  walkFlow(mdast.children, 0, tokens)
  if (tokens.length === 0) return {kind: 'plain'}
  const [only] = tokens
  if (tokens.length === 1 && only.kind === 'paragraph' && !only.content.includes('\n')) {
    return {kind: 'inline', markdown: only.content}
  }
  return {kind: 'outline', blocks: outlineFromTokens(tokens)}
}

/** A page reference `[[…]]`, or a block reference `((…))` to a Roam-style
 *  9-character uid or a UUID. */
const OUTLINER_REFERENCE = /\[\[[^[\]\n]+\]\]|\(\((?:[\w-]{9}|[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12})\)\)/gi

/** Outliner copies (Roam, Logseq) put their `[[page]]` / `((block))`
 *  references in the plain text; HTML beside it is a rendering that has lost
 *  them, so the text is the better source. The same characters inside code
 *  (`if ((ready))`, `m[[i]]`) are just code. */
const hasOutlinerReferences = (plainText: string, body: HTMLElement): boolean => {
  const code = [...body.querySelectorAll('pre, code')]
    .filter(element => element.tagName === 'PRE' || !element.closest('pre')) // a <pre>'s <code> once
    .map(element => element.textContent ?? '')
    .join('\n')
  const references = new Set(plainText.match(OUTLINER_REFERENCE))
  return [...references].some(reference => occurrences(plainText, reference) > occurrences(code, reference))
}

const occurrences = (haystack: string, needle: string): number => haystack.split(needle).length - 1

/** Whether the HTML says anything the plain text doesn't. Plain paragraphs
 *  are what the text path already produces; a lone code block is a copy from
 *  a code view (an IDE, a raw file, a terminal), whose plain text is the
 *  better source. Neither is worth taking over the paste for. A line break is
 *  worth it: the plain text can't tell it from a paragraph break. */
const carriesStructure = (root: Root): boolean => {
  if (root.children.length === 1 && root.children[0].type === 'code') return false
  const hasMarkup = (node: Nodes): boolean =>
    !['root', 'paragraph', 'text'].includes(node.type) ||
    ('children' in node && node.children.some(hasMarkup))
  return hasMarkup(root)
}

const walkFlow = (nodes: readonly RootContent[], indent: number, tokens: OutlineToken[]): void => {
  for (const node of nodes) {
    switch (node.type) {
      case 'heading': {
        const inline = phrasing(node.children, {singleLine: true})
        if (inline) tokens.push({kind: 'heading', level: node.depth, indent, content: `${'#'.repeat(node.depth)} ${inline}`})
        break
      }
      case 'paragraph': {
        const content = phrasing(node.children)
        if (content) tokens.push({kind: 'paragraph', indent, content})
        break
      }
      case 'list':
        node.children.forEach((item, index) => {
          const [first, ...rest] = item.children
          const inline = first?.type === 'paragraph' ? phrasing(first.children) : ''
          if (!inline) {
            // No text of its own (e.g. an item holding only a sub-list):
            // its content nests under whatever precedes it.
            walkFlow(first?.type === 'paragraph' ? rest : item.children, indent + 1, tokens)
            return
          }
          // Ordered items keep their number and task items their checkbox,
          // matching a markdown-text paste of `1. [x] item`.
          // `<ol reversed>` / `<li value>` are not honoured: rare in copied content.
          const number = node.ordered ? `${(node.start ?? 1) + index}. ` : ''
          const checkbox = item.checked == null ? '' : item.checked ? '[x] ' : '[ ] '
          const content = `${number}${checkbox}${inline}`
          tokens.push({kind: 'list-item', indent, content})
          walkFlow(rest, indent + 1, tokens)
        })
        break
      case 'code':
      case 'blockquote':
        if (hasContent(node)) tokens.push({kind: 'atomic', indent, content: markdown(node)})
        break
      case 'table':
        // A GFM table row can't contain a line break.
        if (hasContent(node)) tokens.push({kind: 'atomic', indent, content: markdown(withoutBreaks(node))})
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

/** Split paragraphs where two or more line breaks meet: `<br><br>` is how
 *  plain-text-era pages separate paragraphs, so only a single `<br>` stays a
 *  line break inside its block. In place. */
const splitAtBlankLines = (node: Parents): void => {
  node.children = node.children.flatMap((child): Nodes[] => {
    if (child.type === 'paragraph') return splitParagraph(child)
    if ('children' in child) splitAtBlankLines(child)
    return [child]
  }) as typeof node.children
}

const isBlankText = (node: PhrasingContent | undefined): boolean =>
  node?.type === 'text' && node.value.trim() === ''

const splitParagraph = (paragraph: Paragraph): Paragraph[] => {
  const pieces: PhrasingContent[][] = [[]]
  const children = paragraph.children
  for (let i = 0; i < children.length; i++) {
    if (children[i].type === 'break') {
      // The run of breaks (and the whitespace between them) starting here.
      let end = i + 1
      let breaks = 1
      while (end < children.length && (children[end].type === 'break' || isBlankText(children[end]))) {
        if (children[end].type === 'break') breaks++
        end++
      }
      if (breaks >= 2) {
        pieces.push([])
        i = end - 1
        continue
      }
    }
    pieces[pieces.length - 1].push(children[i])
  }
  // A piece left empty (a leading or trailing run) becomes an empty
  // paragraph, which `walkFlow` skips like any other.
  return pieces.map(children => ({...paragraph, children}))
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
