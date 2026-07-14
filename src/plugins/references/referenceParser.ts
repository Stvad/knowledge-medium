/**
 * Reference parser + renderer for `[[alias]]` and `((block-id))`
 * syntax. Owned by the references plugin — this is the canonical
 * grammar for wikilinks and blockrefs across the codebase.
 *
 * Consumers (outside this plugin): the roam importer reads from
 * here. Anything that emits the syntax should also use the
 * `renderWikilink` / `renderAliasedBlockref` helpers below to avoid
 * drift from parser expectations (`]]` cannot be represented
 * exactly inside wikilink text, `]` / newlines in blockref labels,
 * regex-meta + `$&` in aliases through `rewriteWikilinks`).
 *
 * Plain-text parsing here is preferred over the markdown-aware
 * variant for hot paths; the markdown-aware fallback exists for
 * surfaces that must skip code blocks (see `parseReferencesMarkdownAware`).
 */

import { unified } from 'unified'
import remarkParse from 'remark-parse'
import { visit } from 'unist-util-visit'
import type { Text } from 'mdast'

export interface ParsedReference {
  alias: string;
  startIndex: number;
  endIndex: number;
}

export interface ParsedBlockRef {
  blockId: string;
  startIndex: number;
  endIndex: number;
  embed: boolean;  // true for !((id)), false for plain ((id))
  /** Display label from `[label](((id)))`. Present (possibly `''` —
   *  the renderer falls back to displaying the id) iff the mark used
   *  the aliased form; absent for plain/embed marks. Rewriters key on
   *  presence to preserve the mark's form. */
  label?: string;
}

// UUIDv4 shape — anchors what counts as a block-ref id. We deliberately keep
// this strict so accidental double-parens in prose (e.g. "((not an id))")
// don't get treated as references.
const UUID_RE_SOURCE = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}'
const ALIASED_BLOCK_REF_RE = new RegExp(`\\[([^\\]\\n]*)\\]\\(\\(\\((${UUID_RE_SOURCE})\\)\\)\\)`, 'gi')
const BLOCK_REF_RE = new RegExp(`\\(\\((${UUID_RE_SOURCE})\\)\\)`, 'gi')
const BLOCK_EMBED_RE = new RegExp(`!\\(\\((${UUID_RE_SOURCE})\\)\\)`, 'gi')
const BLOCK_REF_TARGET_RE = new RegExp(`^\\(\\((${UUID_RE_SOURCE})\\)\\)$`, 'i')

export const isBlockRefId = (s: string) => new RegExp(`^${UUID_RE_SOURCE}$`, 'i').test(s)

export const parseBlockRefTarget = (target: string): string | null => {
  const match = BLOCK_REF_TARGET_RE.exec(target.trim())
  return match ? match[1].toLowerCase() : null
}

const parseWikilinkReferences = (content: string): ParsedReference[] => {
  const references: ParsedReference[] = []
  const stack: number[] = [] // Stack to track opening bracket positions
  let i = 0

  while (i < content.length - 1) {
    if (content.slice(i, i + 2) === '[[') {
      stack.push(i)
      i += 2
    } else if (content.slice(i, i + 2) === ']]') {
      if (stack.length > 0) {
        const startPos = stack.pop()!
        const alias = content.slice(startPos + 2, i)
        if (alias) {
          references.push({
            alias,
            startIndex: startPos,
            endIndex: i + 2,
          })
        }
      }
      i += 2
    } else {
      i++
    }
  }

  // Sort references by start position
  return references.sort((a, b) => a.startIndex - b.startIndex)
}

/**
 * Parse every balanced `[[alias]]` pattern from text content. Nested
 * wikilinks emit both the outer and inner references, matching Roam's
 * backlink behavior.
 */
export function parseReferences(content: string): ParsedReference[] {
  return parseWikilinkReferences(content)
}

/**
 * Parse only the outermost balanced `[[alias]]` spans. Use this when a
 * caller needs token boundaries for text rewriting/rendering, where
 * overlapping nested spans would corrupt slicing.
 */
export function parseOutermostReferences(content: string): ParsedReference[] {
  const references = parseWikilinkReferences(content)
  const outermost: ParsedReference[] = []
  let cursor = 0
  for (const ref of references) {
    if (ref.startIndex < cursor) continue
    outermost.push(ref)
    cursor = ref.endIndex
  }
  return outermost
}

/**
 * Parse references using remark for markdown-aware extraction
 * This version respects markdown structure (ignores code blocks, etc.)
 */
export function parseReferencesMarkdownAware(content: string): ParsedReference[] {
  const references: ParsedReference[] = []

  try {
    const tree = unified()
      .use(remarkParse)
      .parse(content)

    visit(tree, 'text', (node: Text, _index, parent) => {
      // Skip if we're inside a code block or inline code
      if (['code', 'inlineCode'].includes(parent?.type as string)) return

      const text = node.value
      // Note: position calculation would need more work for exact positions
      // across markdown nodes. For now, indexes remain relative to this
      // text node, matching the earlier implementation.
      references.push(...parseReferences(text))
    })
  } catch (error) {
    console.warn('Error parsing references:', error)
    // Fallback to regex parsing if remark fails
    return parseReferences(content)
  }

  return references
}

/**
 * Extract just the alias strings from content
 * @param content The text content to parse
 * @returns Array of unique alias strings found
 */
export function extractAliases(content: string): string[] {
  const references = parseReferences(content)
  const uniqueAliases = new Set(references.map(ref => ref.alias))
  return Array.from(uniqueAliases)
}

/**
 * Check if content contains any references
 * @param content The text content to check
 * @returns True if content contains [[alias]] patterns
 */
export function hasReferences(content: string): boolean {
  return parseReferences(content).length > 0
}

/**
 * Parse `((uuid))` block-refs, `!((uuid))` block-embeds, and Roam-style
 * `[label](((uuid)))` aliased block refs out of text. More specific forms are
 * matched first so their inner `((uuid))` spans are not double-counted.
 */
export function parseBlockRefs(content: string): ParsedBlockRef[] {
  const found: ParsedBlockRef[] = []
  const consumed: Array<[number, number]> = []
  const overlapsConsumed = (start: number, end: number) =>
    consumed.some(([s, e]) => start < e && end > s)

  ALIASED_BLOCK_REF_RE.lastIndex = 0
  let match: RegExpExecArray | null
  while ((match = ALIASED_BLOCK_REF_RE.exec(content)) !== null) {
    const start = match.index
    const end = start + match[0].length
    found.push({
      blockId: match[2].toLowerCase(),
      startIndex: start,
      endIndex: end,
      embed: false,
      // Always present for the aliased form, even when '' — a truthy
      // gate here made `[](((id)))` indistinguishable from `((id))`,
      // so rewriteBlockRefs silently degraded the aliased form to a
      // plain ref (changing display semantics from id-fallback to
      // target content). Found by referenceParser.fuzz.
      label: match[1].trim(),
    })
    consumed.push([start, end])
  }

  BLOCK_EMBED_RE.lastIndex = 0
  while ((match = BLOCK_EMBED_RE.exec(content)) !== null) {
    const start = match.index
    const end = start + match[0].length
    if (overlapsConsumed(start, end)) continue
    found.push({
      blockId: match[1].toLowerCase(),
      startIndex: start,
      endIndex: end,
      embed: true,
    })
    consumed.push([start, end])
  }

  BLOCK_REF_RE.lastIndex = 0
  while ((match = BLOCK_REF_RE.exec(content)) !== null) {
    const start = match.index
    const end = start + match[0].length
    if (overlapsConsumed(start, end)) continue
    found.push({
      blockId: match[1].toLowerCase(),
      startIndex: start,
      endIndex: end,
      embed: false,
    })
  }

  return found.sort((a, b) => a.startIndex - b.startIndex)
}

export function extractBlockRefIds(content: string): string[] {
  return Array.from(new Set(parseBlockRefs(content).map(r => r.blockId)))
}

// ──── Rendering helpers (centralized so callers don't build wikilink
//      / blockref syntax via string templates and accidentally diverge
//      from parser expectations). ────

/** Render a wikilink targeting `alias`. If `alias` contains wikilink
 *  delimiters (`[[`, `]]`, or a trailing `]`), the output is
 *  syntactically safe but lossy; callers that need alias identity must
 *  verify by parsing the result. Guarantee: the output always parses to
 *  exactly one outermost reference spanning the whole string, and is
 *  delimiter-balanced so it cannot combine with surrounding text into
 *  a different link. */
export const renderWikilink = (alias: string): string => {
  // `]]` inside the alias would terminate the wikilink at the wrong
  // place, and an unclosed `[[` would leak an opener that a later `]]`
  // anywhere in the document could pair with, swallowing unrelated
  // text. Splitting with a space keeps the visible text close to the
  // input, but it no longer parses to the same alias. Lookahead, not
  // pair replacement: replacing the pair `]]` recreates one on odd
  // runs (']]]' → '] ]]') — the space must land between EVERY two
  // adjacent delimiters. Found by referenceParser.fuzz.
  const safe = alias.replace(/\[(?=\[)/g, '[ ').replace(/\](?=\])/g, '] ')
  // A trailing `]` would pair with the closing delimiter's first `]`
  // and close the link one character early, leaving a stray `]`
  // outside the parsed span.
  const padded = safe.endsWith(']') ? safe + ' ' : safe
  return `[[${padded}]]`
}

/** Render an aliased blockref `[label](((id)))`. Strips `]` and
 *  newlines from `label` because the parser's regex rejects them in
 *  the label segment (see `ALIASED_BLOCK_REF_RE`). `id` is assumed
 *  to be a UUID — already safe. */
export const renderAliasedBlockref = (label: string, id: string): string => {
  // Parser regex: `\[([^\]\n]*)\]\(\(\((UUID)\)\)\)`. Anything in `]`
  // or `\n` would break the match; drop them. Empty label after
  // stripping is allowed — the parser matches `[]` (zero-length
  // label) and the renderer falls back to displaying the id.
  const safeLabel = label.replace(/[\]\n]/g, '')
  return `[${safeLabel}](((${id})))`
}

/** Replace every wikilink whose alias exactly matches `alias` with
 *  the literal `replacement` string. Uses `parseReferences` to find
 *  spans and avoids the
 *  `String.replace` regex-replacement-string pitfall where `$&`,
 *  `$1`, etc. in `replacement` would be interpreted as backreferences
 *  rather than literals. Returns the input unchanged when no span
 *  matches. */
export const rewriteWikilinks = (
  content: string,
  alias: string,
  replacement: string,
): string => {
  if (alias === '') return content  // parser never emits empty-alias marks
  const marks = parseReferences(content)
  if (marks.length === 0) return content
  let result = ''
  let cursor = 0
  for (const mark of marks) {
    // Nested wikilinks (`[[outer [[inner]] tail]]`) produce overlapping
    // spans. Skip any whose start falls inside a span we've already
    // rewritten — replacing both would corrupt the outer's text.
    if (mark.startIndex < cursor) continue
    if (mark.alias !== alias) continue
    result += content.slice(cursor, mark.startIndex)
    result += replacement
    cursor = mark.endIndex
  }
  return cursor === 0 ? content : result + content.slice(cursor)
}

/** Replace block-ref marks targeting `blockId` with inline text — used
 *  when the target block is deleted so its references degrade gracefully
 *  to the text they displayed rather than dangling. Plain `((id))` and
 *  embed `!((id))` marks (which display the target's content) become
 *  `inlineContent`; aliased `[label](((id)))` marks (which display the
 *  label) keep their `label`. Marks targeting other ids are untouched.
 *  Mirrors `rewriteBlockRefs`'s parse-spans-and-slice approach so
 *  `inlineContent` is inserted literally (no `String.replace` `$&`
 *  pitfall) and overlapping/nested marks don't corrupt the slicing. */
export const inlineBlockRefs = (
  content: string,
  blockId: string,
  inlineContent: string,
): string => {
  const normalizedId = blockId.toLowerCase()
  const marks = parseBlockRefs(content)
  if (marks.length === 0) return content
  let result = ''
  let cursor = 0
  for (const mark of marks) {
    if (mark.startIndex < cursor) continue
    if (mark.blockId !== normalizedId) continue
    result += content.slice(cursor, mark.startIndex)
    // Degrade to what the mark DISPLAYED: the label for aliased marks
    // (an empty label displays the id — keep that), the target's
    // content for plain/embed marks.
    result +=
      mark.label === undefined ? inlineContent
      : mark.label !== '' ? mark.label
      : mark.blockId
    cursor = mark.endIndex
  }
  return cursor === 0 ? content : result + content.slice(cursor)
}

/** Replace block-ref ids in `((id))`, `!((id))`, and `[label](((id)))`
 *  forms while preserving embed-ness and display labels. */
export const rewriteBlockRefs = (
  content: string,
  fromId: string,
  toId: string,
): string => {
  const normalizedFrom = fromId.toLowerCase()
  const marks = parseBlockRefs(content)
  if (marks.length === 0) return content
  let result = ''
  let cursor = 0
  for (const mark of marks) {
    if (mark.startIndex < cursor) continue
    if (mark.blockId !== normalizedFrom) continue
    result += content.slice(cursor, mark.startIndex)
    if (mark.label !== undefined) {
      result += renderAliasedBlockref(mark.label, toId)
    } else {
      result += mark.embed ? `!((${toId}))` : `((${toId}))`
    }
    cursor = mark.endIndex
  }
  return cursor === 0 ? content : result + content.slice(cursor)
}
