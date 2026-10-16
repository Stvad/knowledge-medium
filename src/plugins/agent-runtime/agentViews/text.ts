import { neutralizeDisplayText } from '@knowledge-medium/agent-cli/protocol'

/** One display line: hostile characters (line breaks included) collapsed, so
 *  a block can never render as two lines or reorder the id printed after it. */
export const oneLine = (text: string): string =>
  neutralizeDisplayText(text).replace(/[ \t]+/g, ' ').trim()

export const formatCount = (n: number): string => n.toLocaleString('en-US')

/** The marker a cut leaves behind: how much is missing, so an agent can tell
 *  a summary from the whole and knows a fuller read exists. */
export const cutMarker = (cutChars: number): string => `…[+${formatCount(cutChars)} chars]`

export interface Clipped {
  text: string
  /** Characters of the input not in `text` (0 when it fit). */
  cut: number
}

const isHighSurrogate = (code: number): boolean => code >= 0xd800 && code <= 0xdbff

/** `at` moved back by one when it would split a surrogate pair, so a slice
 *  boundary there keeps an astral character (an emoji) whole on one side. */
export const charBoundary = (text: string, at: number): number =>
  at > 0 && at < text.length && isHighSurrogate(text.charCodeAt(at - 1)) ? at - 1 : at

/** Cut to at most `max` characters of the ORIGINAL text, marked. */
export const clip = (text: string, max: number): Clipped => {
  if (text.length <= max) return {text, cut: 0}
  const end = charBoundary(text, max)
  return {text: `${text.slice(0, end)}${cutMarker(text.length - end)}`, cut: text.length - end}
}

/** {@link oneLine} then {@link clip}: the form every list row uses. The
 *  reported cut counts characters of the neutralized line. */
export const clipLine = (text: string, max: number): Clipped => clip(oneLine(text), max)

const SNIPPET_CONTEXT = 70

/** The words a snippet can anchor on: quoted phrases whole, operators and
 *  `-excluded` terms dropped — mirroring what the content search matches. */
const snippetTerms = (query: string): string[] => {
  const terms: string[] = []
  for (const match of query.matchAll(/"([^"]+)"|(\S+)/g)) {
    const phrase = match[1] ?? match[2]
    if (!phrase || phrase === 'OR' || phrase === 'NOT' || phrase.startsWith('-')) continue
    terms.push(phrase.toLowerCase())
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
  const start = Math.max(0, Math.min(at - half, line.length - width))
  const end = Math.min(line.length, start + width)
  return `${start > 0 ? '…' : ''}${line.slice(start, end)}${end < line.length ? '…' : ''}`
}

/** Strip link syntax to see whether a block says anything beyond the links
 *  it carries — `[[Page]]`, `#tag`, `#[[Tag]]`, `((id))`. */
export const textBeyondLinks = (content: string): string =>
  content
    .replace(/#?\[\[[^\]]*\]\]/g, ' ')
    .replace(/\(\([^)]*\)\)/g, ' ')
    .replace(/(^|\s)#[^\s#]+/g, ' ')
    .replace(/[\s,.;:—–-]+/g, ' ')
    .trim()

/** A block that is nothing but references reads as noise on its own (a
 *  backlink list of `[[Page]]` rows says nothing), so views add its parent's
 *  text. */
export const isReferenceOnly = (content: string): boolean =>
  textBeyondLinks(content).length < 3
