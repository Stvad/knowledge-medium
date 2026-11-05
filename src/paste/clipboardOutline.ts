/*
 * A copied outline's structure on the clipboard, for a paste in this app to
 * rebuild exactly. The text/plain the copy writes can't carry it: a multi-line
 * block's continuation lines read back as children, and parsing trims edge
 * whitespace and reads a block's own markers as structure.
 *
 * It rides as an attribute in a text/html item because that is the one
 * carrier every engine's `ClipboardItem` takes that a paste event can read
 * synchronously; a web custom format is Chromium-only, and only
 * `clipboard.read()` sees it.
 *
 * Rich apps read that html instead of the text, so it goes on the clipboard
 * only for a copy whose text does not parse back exactly. Any other copy stays
 * text/plain alone.
 */

import {
  outlineFromTokens,
  parseMarkdownToBlocks,
  type OutlineNode,
  type OutlineToken,
} from '@/utils/markdownParser.js'

/** One copied block, in document order; `depth` is below its copied root. */
export interface OutlineEntry {
  readonly depth: number
  readonly content: string
}

const OUTLINE_ATTRIBUTE = 'data-km-outline'

const bulleted = ({depth, content}: OutlineEntry): string => {
  const indent = '  '.repeat(depth)
  return `${indent}- ${content.split('\n').join(`\n${indent}  `)}`
}

/** The text/plain of a copy: every block is a bullet indented by depth, except
 *  a childless root that is the copy's only root, or that spans lines. Next to
 *  other roots a bare single line is re-read as markdown on paste (a childless
 *  `b` before `- a` adopts `a`), while a fence, quote or table pastes back whole
 *  to another app only unbulleted. */
export const clipboardTextFor = (entries: readonly OutlineEntry[]): string => {
  const severalRoots = entries.filter(entry => entry.depth === 0).length > 1
  return entries
    .map((entry, index) => {
      const childlessRoot = entry.depth === 0 && (entries[index + 1]?.depth ?? 0) === 0
      return childlessRoot && (!severalRoots || entry.content.includes('\n')) ? entry.content : bulleted(entry)
    })
    .join('\n')
}

/** The clipboard's text as a paste reads it: `Blob`s encode UTF-8, which
 *  replaces an unpaired surrogate. */
const asWrittenToClipboard = (text: string): string => text.replace(/\p{Cs}/gu, '�')

const parsesBack = (entries: readonly OutlineEntry[], text: string): boolean => {
  const parsed = parseMarkdownToBlocks(asWrittenToClipboard(text))
  const depthById = new Map<string | undefined, number>([[undefined, -1]])
  return parsed.length === entries.length && parsed.every((block, index) => {
    const depth = depthById.get(block.parentId)! + 1
    depthById.set(block.id, depth)
    return depth === entries[index].depth && block.content === entries[index].content
  })
}

const escapeHtml = (text: string): string =>
  text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;')

/** The text/html of a copy, or undefined when `text` parses back to exactly
 *  `entries` and needs none. A rich app sees the same lines as `text`. Carries
 *  only depth and content, so it exposes nothing the text doesn't. */
export const clipboardHtmlFor = (entries: readonly OutlineEntry[], text: string): string | undefined => {
  if (parsesBack(entries, text)) return undefined
  const payload = JSON.stringify(entries.map(({depth, content}) => ({depth, content})))
  const lines = text.split('\n').map(line => `<div>${escapeHtml(line) || '<br>'}</div>`).join('')
  return `<div ${OUTLINE_ATTRIBUTE}="${escapeHtml(payload)}" style="white-space:pre-wrap">${lines}</div>`
}

const isOutlineEntries = (value: unknown): value is OutlineEntry[] => {
  if (!Array.isArray(value) || value.length === 0) return false
  let deepestAllowed = 0
  return value.every((entry: Partial<OutlineEntry> | null) => {
    const depth = entry?.depth
    if (typeof entry?.content !== 'string' || !Number.isInteger(depth)) return false
    if (depth! < 0 || depth! > deepestAllowed) return false
    deepestAllowed = depth! + 1
    return true
  })
}

/** Normalizes what the platform and the UTF-8 write may have rewritten. */
const comparable = (text: string): string => asWrittenToClipboard(text).replace(/\r\n?/g, '\n')

/** The outline this app copied, when `html` carries one that serializes to
 *  exactly `text`: anything else on the clipboard (a stale or foreign html
 *  item, text rewritten since) reads as null, and the text pastes as usual. */
export const outlineFromClipboard = (html: string | undefined, text: string): OutlineNode[] | null => {
  if (!html?.includes(OUTLINE_ATTRIBUTE)) return null
  let entries: unknown
  try {
    const carrier = new DOMParser().parseFromString(html, 'text/html').querySelector(`[${OUTLINE_ATTRIBUTE}]`)
    entries = JSON.parse(carrier?.getAttribute(OUTLINE_ATTRIBUTE) ?? '')
  } catch {
    return null
  }
  if (!isOutlineEntries(entries)) return null
  if (comparable(clipboardTextFor(entries)) !== comparable(text)) return null
  return outlineFromTokens(entries.map(({depth, content}): OutlineToken => ({kind: 'list-item', indent: depth, content})))
}
