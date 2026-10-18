import { charBoundary, clip, formatCount, neutralizeDisplayText, type Clipped } from '@knowledge-medium/agent-cli/protocol'
import { tokenizeContentSearchQuery } from '@/data/internals/kernelQueries.js'
import { parseBlockRefs, parseOutermostReferences } from '@/plugins/references/referenceParser.js'

export { charBoundary, clip, cutMarker, formatCount, type Clipped } from '@knowledge-medium/agent-cli/protocol'

/** One display line: hostile characters (line breaks included) collapsed, so
 *  a block can never render as two lines or reorder the id printed after it. */
export const oneLine = (text: string): string =>
  neutralizeDisplayText(text).replace(/[ \t]+/g, ' ').trim()

/** SQL for a bounded head of a text column, read where a whole value could
 *  be megabytes (an importer's content). Leading whitespace is skipped first,
 *  so a head that is all whitespace cannot read as empty. A cost bound. */
export const textHeadSql = (column: string, chars: number): string =>
  `substr(ltrim(${column}, ' ' || char(9, 10, 13)), 1, ${chars})`

/** SQL for a block's first alias that says something (the one
 *  `labelForBlockData` picks), cut to `chars`; null when it has none. For live
 *  rows only: no `json_valid` guard, since the alias-index triggers parse a
 *  live row's bag on every write, so `blocks` holds no malformed one. */
export const firstAliasSql = (propertiesColumn: string, chars: number): string => `
  CASE WHEN json_type(${propertiesColumn}, '$.alias') = 'array' THEN (
    SELECT substr(a.value, 1, ${chars}) FROM json_each(${propertiesColumn}, '$.alias') a
     WHERE a.type = 'text' AND trim(a.value) != '' LIMIT 1
  ) END`

/** Cut to at most `max` characters, ending in `…` when cut: for a label or an
 *  id inside a line, where a char-count marker would crowd out the rest. */
export const ellipsize = (text: string, max: number): string =>
  text.length > max ? `${text.slice(0, charBoundary(text, max - 1))}…` : text

/** {@link oneLine} then {@link clip}: the form every list row uses. The
 *  whole text is normalized — one linear pass over text already in memory;
 *  a prefix window was tried and rejected, since a prefix that normalizes
 *  away (leading whitespace, control runs) left the line empty. */
export const clipLine = (text: string, max: number): Clipped => clip(oneLine(text), max)

/** A row's list of user-data names (type labels, property names), bounded
 *  like the row's content: each one clipped, at most `max` kept, and the rest
 *  counted in a last `+N more`. Every such list goes through here — one
 *  unbounded list would make a single block's row arbitrarily large. */
export const boundLabels = (
  labels: readonly string[],
  max: number,
  chars: number,
  total = labels.length,
): string[] => {
  const shown = labels.slice(0, max).map(label => clipLine(label, chars).text)
  return total > shown.length ? [...shown, `+${formatCount(total - shown.length)} more`] : shown
}

const SNIPPET_CONTEXT = 70

/** The words a snippet can anchor on: the positive terms of the query as the
 *  content search itself tokenizes it (a `-"quoted phrase"` or a term after
 *  NOT is excluded, not a match), longest first. */
const snippetTerms = (query: string): string[] => {
  const terms: string[] = []
  let negateNext = false
  for (const token of tokenizeContentSearchQuery(query)) {
    if (token.kind === 'operator') {
      negateNext = token.op === 'NOT'
      continue
    }
    if (!token.excluded && !negateNext) terms.push(token.text.toLowerCase())
    negateNext = false
  }
  return terms.sort((a, b) => b.length - a.length)
}

/** A window of the content around the first match of the query's longest
 *  term, on one line, with `…` where it was cut. Falls back to the start of
 *  the content when no term appears literally (a trigram or phrase match the
 *  search found some other way). */
export const snippet = (content: string, query: string, width = SNIPPET_CONTEXT * 2): string => {
  const line = oneLine(content)
  if (line.length <= width) return line
  const lower = line.toLowerCase()
  let at = -1
  let termLength = 0
  for (const term of snippetTerms(query)) {
    at = lower.indexOf(term)
    if (at >= 0) {
      termLength = term.length
      break
    }
  }
  if (at < 0) return clip(line, width).text
  const half = Math.max(0, Math.floor((width - termLength) / 2))
  const start = charBoundary(line, Math.max(0, Math.min(at - half, line.length - width)))
  const end = charBoundary(line, Math.min(line.length, start + width))
  return `${start > 0 ? '…' : ''}${line.slice(start, end)}${end < line.length ? '…' : ''}`
}

/** Strip link-like syntax — `[[Page]]`, `#tag`, `#[[Tag]]`, `((id))` — to see
 *  whether a block says anything beyond what it links. A noise heuristic,
 *  so it is looser than the reference parser {@link isLabel} goes by. */
export const textBeyondLinks = (content: string): string =>
  content
    .replace(/#?\[\[[^\]]*\]\]/g, ' ')
    .replace(/\(\([^)]*\)\)/g, ' ')
    .replace(/(^|\s)#[^\s#]+/g, ' ')
    .replace(/[\s,.;:—–-]+/g, ' ')
    .trim()

/** What may sit between a label's references: spacing, punctuation, and the
 *  `#` that makes a wikilink a tag link (`#[[Tag]]`). */
const LABEL_FILLER = /[\s,.;:—–#-]/g

/** How long a quoted neighbour's line is. */
const CONTEXT_CHARS = 160
/** How much of a neighbour's content a context line reads (a cost bound);
 *  roomy, so collapsing its whitespace rarely leaves less than a line. */
export const CONTEXT_HEAD_CHARS = CONTEXT_CHARS * 4

/** A neighbour's text as context: one line, ellipsized. It says it is cut,
 *  not by how much, since only a head was read. */
export const contextPreview = (head: string): string => ellipsize(oneLine(head), CONTEXT_CHARS)

/** A block that is nothing but references reads as noise on its own (a
 *  backlink list of `[[Page]]` rows says nothing), so views add its parent's
 *  text. */
export const isReferenceOnly = (content: string): boolean =>
  textBeyondLinks(content).length < 3

/** A label is a block of references and nothing else, at least one, as the
 *  reference parser reads them (`[[Meeting]]`, `#[[Tag]]`, `((block id))`):
 *  the head of a record whose lines are its children. A bare `#tag` is text
 *  here, as it is to backlinks, and an embed (`!((id))`) shows its target's
 *  content rather than linking to it. */
export const isLabel = (content: string): boolean => {
  const spans = [...parseOutermostReferences(content), ...parseBlockRefs(content).filter(ref => !ref.embed)]
    .sort((a, b) => a.startIndex - b.startIndex)
  if (spans.length === 0) return false
  let rest = ''
  let cursor = 0
  for (const span of spans) {
    if (span.startIndex > cursor) rest += content.slice(cursor, span.startIndex)
    cursor = Math.max(cursor, span.endIndex)
  }
  rest += content.slice(cursor)
  return rest.replace(LABEL_FILLER, '') === ''
}
