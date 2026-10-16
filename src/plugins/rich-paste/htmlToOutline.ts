import { fromDom } from 'hast-util-from-dom'
import { toMdast } from 'hast-util-to-mdast'
import type {
  Delete, Emphasis, InlineCode, Link, Nodes, Paragraph, Parents, PhrasingContent, Root, RootContent, Strong, Text,
} from 'mdast'
import { gfmToMarkdown } from 'mdast-util-gfm'
import { toMarkdown, type Options as ToMarkdownOptions } from 'mdast-util-to-markdown'
import { parseBlockRefs, parseOutermostReferences } from '@/plugins/references/referenceParser.js'
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
  const mdast = separateBlocks(toMdast(fromDom(body)) as Root)
  sanitize(mdast)
  splitAtBlankLines(mdast)
  // With no plain text (an html-only clipboard) the html is the only source.
  if (plainText.trim() && !(carriesStructure(mdast, isCodeView(body)) && keepsAllText(body, mdast))) return {kind: 'plain'}

  const tokens: OutlineToken[] = []
  walkFlow(mdast.children, 0, tokens)
  if (tokens.length === 0) return {kind: 'plain'}
  const [only] = tokens
  if (tokens.length === 1 && only.kind === 'paragraph' && !only.content.includes('\n')) {
    // The plain text's lines are ones the html failed to mark (CSS-drawn
    // breaks); a one-line insert would run them together.
    if (plainText.trim().includes('\n')) return {kind: 'plain'}
    // Whitespace minification drops the selection's edge spaces (a
    // double-clicked word's trailing one); restore them from the plain text
    // so a caret paste doesn't glue words together.
    const lead = /^[ \t]*/.exec(plainText)?.[0] ?? ''
    const trail = /[ \t]*$/.exec(plainText)?.[0] ?? ''
    return {kind: 'inline', markdown: `${lead}${only.content}${trail}`}
  }
  return {kind: 'outline', blocks: outlineFromTokens(tokens)}
}

/** Roam's 9-character block uids, which this app's own grammar (UUIDs) doesn't read. */
const ROAM_BLOCK_REFERENCE = /\(\([\w-]{9}\)\)/g

/** The reference spans in `text`: this app's grammar — balanced `[[page]]`
 *  aliases and `((uuid))` refs, as the references plugin parses them — plus
 *  Roam's uid refs. */
const outlinerReferences = (text: string): string[] => [
  ...[...parseOutermostReferences(text), ...parseBlockRefs(text)]
    .map(reference => text.slice(reference.startIndex, reference.endIndex)),
  ...(text.match(ROAM_BLOCK_REFERENCE) ?? []),
]

/** Outliner copies (Roam, Logseq) put their `[[page]]` / `((block))`
 *  references in the plain text; HTML beside it is a rendering that has lost
 *  them, so the text is the better source. The same characters inside code
 *  (`if ((ready))`, `m[[i]]`) are just code. */
const hasOutlinerReferences = (plainText: string, body: HTMLElement): boolean => {
  const code = [...body.querySelectorAll('pre, code')]
    .filter(element => element.tagName === 'PRE' || !element.closest('pre')) // a <pre>'s <code> once
    .map(element => element.textContent ?? '')
    .join('\n')
  const inCode = counts(outlinerReferences(code))
  return [...counts(outlinerReferences(plainText))].some(([reference, count]) => count > (inCode.get(reference) ?? 0))
}

const counts = (items: readonly string[]): Map<string, number> => {
  const result = new Map<string, number>()
  for (const item of items) result.set(item, (result.get(item) ?? 0) + 1)
  return result
}

/** A copy from a code *view* — an IDE, a raw file, a terminal — rather than
 *  a code block on a page: a `<pre>` with no `<code>` (web and chat code
 *  blocks mark theirs). */
const isCodeView = (body: HTMLElement): boolean => !body.querySelector('code')

/** Whether the HTML says anything the plain text doesn't. Plain paragraphs
 *  are what the text path already produces, and a code view's plain text is
 *  the better source (it may be a markdown file to parse as an outline).
 *  Neither is worth taking over the paste for. A line break is worth it: the
 *  plain text can't tell it from a paragraph break. */
const carriesStructure = (root: Root, codeView: boolean): boolean => {
  if (codeView && root.children.length === 1 && root.children[0].type === 'code') return false
  const hasMarkup = (node: Nodes): boolean =>
    !['root', 'paragraph', 'text'].includes(node.type) ||
    ('children' in node && node.children.some(hasMarkup))
  return hasMarkup(root)
}

/** Whether the conversion kept every letter and digit of the HTML's text,
 *  in order. The converter ignores some elements outright (`<math>`,
 *  `<menu>`…); silently losing their text is worse than pasting plain. */
const keepsAllText = (body: HTMLElement, root: Root): boolean =>
  alphanumerics(literalText(root)) === alphanumerics(body.textContent ?? '')

const alphanumerics = (text: string): string => text.replace(/[^\p{L}\p{N}]/gu, '')

const literalText = (node: Nodes): string =>
  'value' in node ? node.value : 'children' in node ? node.children.map(literalText).join('') : ''

const walkFlow = (nodes: readonly RootContent[], indent: number, tokens: OutlineToken[]): void => {
  for (const node of nodes) {
    switch (node.type) {
      case 'heading': {
        const inline = phrasing(withoutBreaks(node).children)
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
          if (inline) {
            // Ordered items keep their number and task items their checkbox,
            // matching a markdown-text paste of `1. [x] item`.
            // `<ol reversed>` / `<li value>` are not honoured: rare in copied content.
            const number = node.ordered ? `${(node.start ?? 1) + index}. ` : ''
            const checkbox = item.checked == null ? '' : item.checked ? '[x] ' : '[ ] '
            tokens.push({kind: 'list-item', indent, content: `${number}${checkbox}${inline}`})
          }
          // An item with no text of its own (e.g. only a sub-list) nests its
          // content under whatever precedes it.
          walkFlow(inline ? rest : item.children, indent + 1, tokens)
        })
        break
      case 'listItem': // an `<li>` outside a list
        walkFlow([{type: 'list', children: [node]}], indent, tokens)
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
  // Blocks render with `white-space: pre-wrap`, so a plain newline is a line
  // break — the same thing Shift+Enter types — where markdown's `\` hard
  // break would show its backslash in the editor.
  handlers: {break: () => '\n'},
  // The serializer spells the character beside emphasis as a reference when
  // it must (the `A` of `A**!**`), but only after escaping the text, so a
  // backslash before it would escape the `&` instead (an upstream bug).
  unsafe: [{character: '\\', after: '.[*_]', unicode: true}],
}

const markdown = (node: Nodes): string =>
  toMarkdown(node, MARKDOWN_OPTIONS).replace(/\n+$/, '')

/** Inline markdown for phrasing content, escaped so a block that merely
 *  starts with `#`, `-` or `1.` isn't read back as a heading or list; empty
 *  when there is no text or image (whitespace alone, such as a heading's
 *  lone line break, would otherwise serialize as `&#x20;`). */
const phrasing = (children: PhrasingContent[]): string =>
  children.some(hasContent) ? markdown({type: 'paragraph', children}).trim() : ''

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

/** The block types the converter emits. */
const BLOCKS: ReadonlySet<Nodes['type']> = new Set([
  'blockquote', 'code', 'heading', 'list', 'listItem', 'paragraph', 'table', 'thematicBreak',
])

/** Markdown keeps phrasing and blocks apart; the converter mixes them where
 *  the HTML does. It reads a `<summary>` as a paragraph, leaves blocks inside
 *  `<b>` or `<i>`, and, splitting a link around the blocks in it, puts the
 *  link inside a list; serialized there, a block's text runs into its
 *  neighbours or is dropped. And it puts a list's content outside its items
 *  in an item of its own, bare, where no block reads it. So each block is
 *  lifted out beside the phrasing around it, dropping the inline markup that
 *  wrapped it, and bare phrasing in a list item becomes a paragraph. */
const separateBlocks = (root: Root): Root => separate(root)[0] as Root

/** `node` as a sequence of nodes in which phrasing and blocks don't mix. */
const separate = (node: Nodes): Nodes[] => {
  if (!('children' in node)) return [node]
  const children = (node.children as Nodes[]).flatMap(separate)
  if (node.type === 'paragraph' || node.type === 'heading' || isInlineMarkup(node)) {
    return aroundBlocks(children, run => [{...node, children: run} as Nodes])
  }
  if (node.type === 'listItem') {
    // A run with no text (a `<br>` between items) is no paragraph.
    const paragraph = (run: Nodes[]): Nodes[] =>
      run.some(hasContent) ? [{type: 'paragraph', children: run as PhrasingContent[]}] : []
    return [{...node, children: aroundBlocks(children, paragraph)} as Nodes]
  }
  return [{...node, children} as Nodes]
}

/** `nodes` with each run of phrasing between their blocks replaced by `wrap(run)`. */
const aroundBlocks = (nodes: readonly Nodes[], wrap: (run: Nodes[]) => Nodes[]): Nodes[] => {
  const result: Nodes[] = []
  let run: Nodes[] = []
  for (const node of nodes) {
    if (!BLOCKS.has(node.type)) {
      run.push(node)
      continue
    }
    if (run.length > 0) result.push(...wrap(run))
    result.push(node)
    run = []
  }
  if (run.length > 0) result.push(...wrap(run))
  return result
}

/** Split paragraphs where two or more line breaks meet: `<br><br>` is how
 *  plain-text-era pages separate paragraphs, so only a single `<br>` stays a
 *  line break inside its block. In place. A run inside inline markup
 *  (`<b>a<br><br>b</b>`) is not split: rare, and it would split the markup. */
const splitAtBlankLines = (node: Parents): void => {
  node.children = node.children.flatMap((child): Nodes[] => {
    if (child.type === 'paragraph') return splitParagraph(child)
    if ('children' in child) splitAtBlankLines(child)
    return [child]
  }) as typeof node.children
}

const isBlankText = (node: PhrasingContent): boolean =>
  node.type === 'text' && node.value.trim() === ''

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
 *  `blob:` images) and link titles, and tidy inline markup, code spans and
 *  the text left touching, in place. `markupAround` is the inline markup
 *  `node` sits in. */
const sanitize = (node: Parents, markupAround: ReadonlySet<Nodes['type']> = new Set()): void => {
  const around = isInlineMarkup(node) ? new Set([...markupAround, node.type]) : markupAround
  node.children = spellable(around.has('link'), node.children.flatMap((child): Nodes[] => {
    if (child.type === 'link') {
      const href = absoluteHref(child.url)
      if (href === undefined) {
        sanitize(child, around)
        return child.children
      }
      child.url = href
      child.title = null // a hover tooltip on the source page; clutter in a block
    }
    if (child.type === 'image') {
      if (absoluteHref(child.url, IMAGE_PROTOCOLS) === undefined) return []
      child.title = null
    }
    if ('children' in child) sanitize(child, around)
    if (!isInlineMarkup(child)) return [child]
    // Markup inside the same markup adds nothing, and nested strikes (`~~~~`)
    // would open a code fence.
    return around.has(child.type) ? child.children : withEdgeWhitespaceOutside(child)
  })) as typeof node.children
}

/** `nodes` as markdown can spell them: touching text joined, touching code
 *  spans too, and empty code spans dropped. The serializer escapes each text
 *  on its own, so syntax that forms only across two goes unescaped (`1` and
 *  `. Install` read back as a list item); an empty code span writes as two
 *  literal backticks (two in a row open a code fence); and `` `a``b` `` reads
 *  back as one span holding the backticks. In a link, code that would end a
 *  definition's label becomes a text of its own — checked once spans are
 *  joined, as `]:` can form across two. */
const spellable = (inLink: boolean, nodes: Nodes[]): Nodes[] => {
  const joined = joinTouching(nodes)
  if (!inLink) return joined
  return joined.map((node): Nodes => endsDefinitionLabel(node) ? {type: 'text', value: node.value} : node)
}

/** Read back, a link's text ends at its first `]` when it could be a
 *  definition's label (`` [`a]: b`](…) `` defines `` `a ``), and code can't
 *  escape one. */
const endsDefinitionLabel = (node: Nodes): node is InlineCode =>
  node.type === 'inlineCode' && node.value.includes(']:')

const joinTouching = (nodes: readonly Nodes[]): Nodes[] => {
  const kept: Nodes[] = []
  for (const node of nodes) {
    if (node.type === 'inlineCode' && node.value === '') continue
    const previous = kept.at(-1)
    if (joinable(node) && previous && joinable(previous) && previous.type === node.type) previous.value += node.value
    else kept.push(node)
  }
  return kept
}

const joinable = (node: Nodes): node is InlineCode | Text => node.type === 'inlineCode' || node.type === 'text'

type InlineMarkup = Delete | Emphasis | Link | Strong

const isInlineMarkup = (node: Nodes): node is InlineMarkup =>
  node.type === 'delete' || node.type === 'emphasis' || node.type === 'link' || node.type === 'strong'

/** `markup` with the whitespace at its edges moved outside it — markdown
 *  can't close emphasis after a space, so the serializer would write the
 *  space as `&#x20;` — or unwrapped when nothing is left inside it (an icon's
 *  empty `<i>`, an anchor link whose only content was an icon). */
const withEdgeWhitespaceOutside = (markup: InlineMarkup): PhrasingContent[] => {
  const lead = takeEdgeWhitespace(markup.children[0], /^\s+/)
  const trail = takeEdgeWhitespace(markup.children.at(-1), /\s+$/)
  return [...lead, ...(hasContent(markup) ? [markup] : markup.children), ...trail]
}

/** Remove the whitespace `edge` matches from `node` if it is text, returning
 *  it as a text node of its own. */
const takeEdgeWhitespace = (node: PhrasingContent | undefined, edge: RegExp): Text[] => {
  if (node?.type !== 'text') return []
  const whitespace = edge.exec(node.value)?.[0]
  if (!whitespace) return []
  node.value = node.value.replace(edge, '')
  return [{type: 'text', value: whitespace}]
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
