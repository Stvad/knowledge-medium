import {
  parseOutermostReferences,
  parseReferences,
  type ParsedReference,
} from '@/plugins/references/referenceParser.js'
import { rewriteRoamHashtags } from './content.js'
import { DAILY_NOTE_TYPE } from '@/plugins/daily-notes/schema.js'
import { parseLiteralDailyPageTitle } from '@/utils/relativeDate.js'

const NS_PREFIX = 'roam'
export const ROAM_PAGE_ALIAS_PROP = `${NS_PREFIX}:page_alias`
export const ROAM_AUTHOR_PROP = `${NS_PREFIX}:author`
export const ROAM_ISA_PROP = `${NS_PREFIX}:isa`
export const ROAM_EMBED_PATH_PROP = `${NS_PREFIX}:embed-path`
export const ROAM_URL_PROP = `${NS_PREFIX}:URL`
export const ROAM_TIMESTAMP_PROP = `${NS_PREFIX}:timestamp`
export const ROAM_MESSAGE_URL_PROP = `${NS_PREFIX}:message-url`
export const ROAM_MESSAGE_AUTHOR_PROP = `${NS_PREFIX}:message-author`
export const ROAM_MESSAGE_TIMESTAMP_PROP = `${NS_PREFIX}:message-timestamp`

export const isRoamSemanticRefListProperty = (name: string): boolean =>
  name === ROAM_ISA_PROP || name === ROAM_PAGE_ALIAS_PROP

/** Tally of token aliases observed for a single property during
 *  schema reconciliation. Inputs to `inferRefListTargetTypes`. */
export interface RefListTokenTally {
  /** Total token aliases seen across all values. A value like
   *  `[[A]] [[B]]` contributes 2; `['[[A]]', '[[B]]']` contributes 2. */
  readonly total: number
  /** Subset of `total` whose alias parses as a daily-note page title
   *  (canonical ISO or canonical Roam form per `parseLiteralDailyPageTitle`). */
  readonly dailyNote: number
}

/** Given the per-property token tally, return the `targetTypes` to use
 *  when registering the property's refList schema. Conservative — only
 *  emits a result when every observed token unanimously fits a known
 *  target type, so users with mixed-target Roam properties land on an
 *  un-constrained refList that they can refine via RefTargetTypePicker. */
export const inferRefListTargetTypes = (
  tally: RefListTokenTally,
): readonly string[] | undefined => {
  if (tally.total === 0) return undefined
  if (tally.total === tally.dailyNote) return [DAILY_NOTE_TYPE]
  return undefined
}

/** True iff `alias` is a canonical daily-note page title (ISO or
 *  Roam-style) — i.e. the import will resolve it to a daily-note block. */
export const isDailyNoteAlias = (alias: string): boolean =>
  parseLiteralDailyPageTitle(alias) !== null

export const uniqueExactStrings = (values: readonly string[]): string[] => {
  const out: string[] = []
  const seen = new Set<string>()
  for (const value of values) {
    if (value === '' || seen.has(value)) continue
    seen.add(value)
    out.push(value)
  }
  return out
}

const namespacedKey = (key: string): string => {
  // Roam keys come in two flavors: `:foo` (Datalog) and `foo` (camel).
  // Strip the leading `:` if present, then prefix our namespace.
  const cleaned = key.startsWith(':') ? key.slice(1) : key
  return `${NS_PREFIX}:${cleaned}`
}

const findUnescaped = (value: string, target: string, start: number): number => {
  for (let i = start; i < value.length; i++) {
    if (value[i] === '\\') {
      i += 1
      continue
    }
    if (value[i] === target) return i
  }
  return -1
}

const findMarkdownLinkDestinationEnd = (value: string, start: number): number => {
  let depth = 1
  for (let i = start; i < value.length; i++) {
    const ch = value[i]
    if (ch === '\\') {
      i += 1
      continue
    }
    if (ch === '(') {
      depth += 1
      continue
    }
    if (ch === ')') {
      depth -= 1
      if (depth === 0) return i
    }
  }
  return -1
}

/** If a Roam property value is exactly one markdown link, store the
 *  destination as the queryable value while leaving the original
 *  source block's content untouched in the imported tree. */
export const normalizeRoamPropertyValue = (value: string): string => {
  const trimmed = value.trim()
  if (!trimmed.startsWith('[')) return value

  const labelEnd = findUnescaped(trimmed, ']', 1)
  if (labelEnd < 0 || trimmed[labelEnd + 1] !== '(') return value

  const destinationStart = labelEnd + 2
  const destinationEnd = findMarkdownLinkDestinationEnd(trimmed, destinationStart)
  if (destinationEnd < 0 || destinationEnd !== trimmed.length - 1) return value

  const destination = trimmed.slice(destinationStart, destinationEnd).trim()
  return destination === '' ? value : destination
}

const parseLeadingMarkdownLink = (
  value: string,
): {label: string, destination: string, end: number} | null => {
  const trimmedStart = value.match(/^\s*/)?.[0].length ?? 0
  if (value[trimmedStart] !== '[') return null

  const labelEnd = findUnescaped(value, ']', trimmedStart + 1)
  if (labelEnd < 0 || value[labelEnd + 1] !== '(') return null

  const destinationStart = labelEnd + 2
  const destinationEnd = findMarkdownLinkDestinationEnd(value, destinationStart)
  if (destinationEnd < 0) return null

  return {
    label: value.slice(trimmedStart + 1, labelEnd).trim(),
    destination: value.slice(destinationStart, destinationEnd).trim(),
    end: destinationEnd + 1,
  }
}

export interface PageToken {
  alias: string
  start: number
  end: number
}

const pageTokenFromReference = (ref: ParsedReference): PageToken => ({
  alias: ref.alias,
  start: ref.startIndex,
  end: ref.endIndex,
})

const outerPageTokens = (value: string): PageToken[] =>
  parseOutermostReferences(value).map(pageTokenFromReference)

const allPageTokens = (value: string): PageToken[] =>
  parseReferences(value).map(pageTokenFromReference)

const isPageTokenListValue = (
  value: string,
  tokens: ReadonlyArray<PageToken>,
): boolean => {
  if (tokens.length === 0) return false
  let cursor = 0
  for (const token of tokens) {
    if (!/^[\s,;]*$/.test(value.slice(cursor, token.start))) return false
    cursor = token.end
  }
  return /^[\s,;]*$/.test(value.slice(cursor))
}

export const explodePageTokens = (value: string): string[] | null => {
  const tokens = parsePageTokenList(value)
  if (!tokens) return null
  const out = tokens.map(token => `[[${token.alias}]]`)
  // Single token: not really a "list", let the caller keep the scalar.
  if (out.length < 2) return null
  return out
}

export const parsePageTokenList = (value: string): PageToken[] | null => {
  const tokens = outerPageTokens(value)
  return isPageTokenListValue(value, tokens) ? tokens : null
}

// Collect every `[[X]]` token nested inside a property value. Used to
// register page-link targets from property values into ctx.aliasesUsed
// so the seat-creation pipeline materialises them.
export const collectAliasesFromPropertyValues = (
  promoted: Record<string, unknown>,
): string[] => {
  const out = new Set<string>()
  const visit = (v: unknown) => {
    if (typeof v === 'string') {
      for (const token of allPageTokens(v)) out.add(token.alias)
    } else if (Array.isArray(v)) {
      for (const item of v) visit(item)
    }
  }
  for (const [name, v] of Object.entries(promoted)) {
    if (isRoamSemanticRefListProperty(name)) continue
    visit(v)
  }
  return [...out]
}

const looksSerializedJson = (value: string): boolean =>
  (value.startsWith('{') && value.endsWith('}')) ||
  (value.startsWith('[') && value.endsWith(']') && !value.startsWith('[['))

const parseQuotedAliasListValue = (value: string): string[] | null => {
  const out: string[] = []
  let i = 0
  const skipSpace = () => {
    while (i < value.length && /\s/.test(value[i])) i += 1
  }

  while (i < value.length) {
    skipSpace()
    if (i >= value.length) break
    const quote = value[i]
    if (quote !== '"' && quote !== "'") return null
    i += 1

    let alias = ''
    let closed = false
    while (i < value.length) {
      const ch = value[i]
      if (ch === '\\' && i + 1 < value.length) {
        alias += value[i + 1]
        i += 2
        continue
      }
      if (ch === quote) {
        closed = true
        i += 1
        break
      }
      alias += ch
      i += 1
    }
    if (!closed) return null

    if (alias === '') return null
    out.push(alias)

    skipSpace()
    if (i >= value.length) break
    if (value[i] !== ',') return null
    i += 1
  }

  return out.length > 0 ? uniqueExactStrings(out) : null
}

const isConservativePlainAlias = (value: string): boolean => {
  if (!value) return false
  if (looksSerializedJson(value)) return false
  if (value.startsWith('#')) return false
  if (['{', '}', '[', ']', '*', ',', ';', ':'].some(ch => value.includes(ch))) return false
  if (/https?:\/\//i.test(value)) return false

  const words = value.split(/\s+/).filter(Boolean)
  if (words.length === 0 || words.length > 4) return false

  const hasNonAscii = Array.from(value).some(ch => ch.codePointAt(0)! > 0x7F)
  const hasExplicitNameSignal = /[A-Z0-9@]/.test(value) || hasNonAscii
  return hasExplicitNameSignal || words.length === 1
}

type PlainAliasMode = 'broad' | 'conservative'

export const collectAliasesFromRoamSemanticRefListValue = (
  value: unknown,
  plainAliasMode: PlainAliasMode = 'broad',
): string[] => {
  if (Array.isArray(value)) {
    return uniqueExactStrings(value.flatMap(item =>
      collectAliasesFromRoamSemanticRefListValue(item, plainAliasMode)))
  }
  if (typeof value !== 'string') return []

  const trimmed = rewriteSemanticRefListValue(value)
  if (!trimmed) return []

  const tokens = parsePageTokenList(trimmed)
  if (tokens) return uniqueExactStrings(tokens.map(token => token.alias))
  if (parseReferences(trimmed).length > 0) return []

  const quotedAliases = parseQuotedAliasListValue(trimmed)
  if (quotedAliases) return quotedAliases

  if (plainAliasMode === 'conservative') {
    return isConservativePlainAlias(trimmed) ? [trimmed] : []
  }
  return looksSerializedJson(trimmed) ? [] : [trimmed]
}

// Roam attribute values can use bare `#tag` syntax (`isa:: #CFAR
// #Coaching`). Rewrite to `[[tag]]` wikilinks before alias extraction so
// each tag becomes its own page ref — otherwise the whole hashtag string
// was captured as one literal page title (`#CFAR #Coaching`). Quoted-list
// and serialized-JSON values keep their `#`, since a `#` there isn't a
// Roam tag.
const rewriteSemanticRefListValue = (value: string): string => {
  const trimmed = value.trim()
  if (!trimmed.includes('#')) return trimmed
  if (trimmed.startsWith('"') || trimmed.startsWith("'")) return trimmed
  if (looksSerializedJson(trimmed)) return trimmed
  return rewriteRoamHashtags(trimmed)
}

export const collectAliasesFromRoamSemanticRefListProperties = (
  properties: Record<string, unknown>,
): string[] =>
  uniqueExactStrings(Object.entries(properties)
    .filter(([name]) => isRoamSemanticRefListProperty(name))
    .flatMap(([name, value]) =>
      collectReferencedAliasesFromRoamSemanticRefListValue(
        value,
        name === ROAM_PAGE_ALIAS_PROP ? 'conservative' : 'broad',
      )))

const collectReferencedAliasesFromRoamSemanticRefListValue = (
  value: unknown,
  plainAliasMode: PlainAliasMode,
): string[] => {
  if (Array.isArray(value)) {
    return uniqueExactStrings(value.flatMap(item =>
      collectReferencedAliasesFromRoamSemanticRefListValue(item, plainAliasMode)))
  }
  if (typeof value !== 'string') return []

  const trimmed = rewriteSemanticRefListValue(value)
  if (!trimmed) return []

  const tokens = parsePageTokenList(trimmed)
  if (tokens) return uniqueExactStrings(parseReferences(trimmed).map(ref => ref.alias))
  if (parseReferences(trimmed).length > 0) return []

  const quotedAliases = parseQuotedAliasListValue(trimmed)
  if (quotedAliases) return quotedAliases

  if (plainAliasMode === 'conservative') {
    return isConservativePlainAlias(trimmed) ? [trimmed] : []
  }
  return looksSerializedJson(trimmed) ? [] : [trimmed]
}

/** Translate Roam's property bag into the new flat-property shape:
 *  values are stored encoded directly under their (namespaced) key.
 *  Numbers stay numbers, strings stay strings, structured values are
 *  JSON-stringified for round-trip. The Roam namespace prefix
 *  (`roam:`) keeps these from colliding with kernel properties. */
export const propertiesFromRoam = (
  raw: Record<string, unknown>,
): Record<string, unknown> => {
  const out: Record<string, unknown> = {}

  for (const [key, value] of Object.entries(raw)) {
    const propName = namespacedKey(key)
    if (typeof value === 'number') {
      out[propName] = value
    } else if (typeof value === 'string') {
      out[propName] = normalizeRoamPropertyValue(value)
    } else if (value !== null && value !== undefined) {
      // Object/array values: stringify so the data round-trips;
      // a follow-up can promote structured values once we have
      // more known shapes.
      out[propName] = JSON.stringify(value)
    }
  }

  return out
}

const collectStandardPageAliasValues = (value: unknown): string[] => {
  const values = Array.isArray(value) ? value : [value]
  const out: string[] = []
  for (const item of values) {
    if (typeof item !== 'string') continue
    const trimmed = item.trim()
    if (!trimmed) continue
    const tokens = parsePageTokenList(trimmed)
    if (!tokens) continue
    out.push(...tokens.map(token => token.alias))
  }
  return out
}

export const collectPageAliases = (properties: Record<string, unknown>): string[] =>
  uniqueExactStrings(collectStandardPageAliasValues(properties[ROAM_PAGE_ALIAS_PROP]))

export const nonStandardPageAliasValues = (
  properties: Record<string, unknown>,
): string[] => {
  const value = properties[ROAM_PAGE_ALIAS_PROP]
  const values = Array.isArray(value) ? value : [value]
  const out: string[] = []
  for (const item of values) {
    if (item === undefined || item === null) continue
    if (typeof item !== 'string') {
      out.push(JSON.stringify(item))
      continue
    }
    const trimmed = item.trim()
    if (!trimmed) continue
    if (!parsePageTokenList(trimmed)) out.push(trimmed)
  }
  return out
}

interface LeadingPageRef {
  alias: string
  start: number
  end: number
}

interface LeadingTitle {
  kind: 'wiki' | 'markdown'
  label: string
  start: number
  end: number
  destination?: string
}

export interface ContentDerivedProperties {
  content: string
  properties: Record<string, unknown>
  diagnostics: string[]
}

const READWISE_READ_URL_RE = /^https:\/\/read\.readwise\.io\/read\/[^\s<>)\]]+/i
const URL_RE = /https?:\/\/[^\s<>)\]]+/i

const parseLeadingPageRef = (value: string): LeadingPageRef | null =>
  outerPageTokens(value).find(token => /^\s*$/.test(value.slice(0, token.start))) ?? null

const parseLeadingTitle = (value: string): LeadingTitle | null => {
  const pageRef = parseLeadingPageRef(value)
  if (pageRef) {
    const afterPageRef = value.slice(pageRef.end)
    if (afterPageRef.startsWith('(')) {
      const destinationEnd = findMarkdownLinkDestinationEnd(value, pageRef.end + 1)
      if (destinationEnd > 0) {
        return {
          kind: 'wiki',
          label: pageRef.alias,
          start: pageRef.start,
          end: destinationEnd + 1,
          destination: value.slice(pageRef.end + 1, destinationEnd).trim(),
        }
      }
    }
    return {
      kind: 'wiki',
      label: pageRef.alias,
      start: pageRef.start,
      end: pageRef.end,
    }
  }

  const markdown = parseLeadingMarkdownLink(value)
  if (!markdown) return null
  return {
    kind: 'markdown',
    label: markdown.label,
    start: value.match(/^\s*/)?.[0].length ?? 0,
    end: markdown.end,
    destination: markdown.destination,
  }
}

const readwiseUrlFromDestination = (destination: string | undefined): string | undefined => {
  if (!destination) return undefined
  const match = READWISE_READ_URL_RE.exec(destination.trim())
  return match?.[0]
}

const firstUrl = (value: string): string | undefined =>
  URL_RE.exec(value)?.[0]

const authorPageRef = (value: string): string | undefined => {
  const trimmed = value.replace(/\s+/g, ' ').trim()
  if (!trimmed || trimmed === '[[]]') return undefined
  const refs = parseReferences(trimmed)
  if (refs.length === 1 && refs[0].startIndex === 0 && refs[0].endIndex === trimmed.length) {
    return `[[${refs[0].alias}]]`
  }
  if (refs.length > 0) return undefined
  return `[[${trimmed}]]`
}

const exactAuthorRefs = (value: string): string[] | null => {
  const tokens = parsePageTokenList(value)
  if (!tokens) return null
  return tokens
    .map(token => token.alias)
    .filter(alias => alias !== '')
    .map(alias => `[[${alias}]]`)
}

const pushUrl = (urls: string[], value: string | undefined) => {
  if (!value) return
  const trimmed = value.trim()
  if (trimmed && !urls.includes(trimmed)) urls.push(trimmed)
}

const setUrlProperties = (
  properties: Record<string, unknown>,
  urls: readonly string[],
) => {
  if (urls.length === 0) return
  properties[ROAM_URL_PROP] = urls.length === 1 ? urls[0] : [...urls]
}

const docAliasFromMarkdownLabel = (label: string): string => {
  const cleaned = label.replace(/\s+/g, ' ').trim()
  return cleaned.startsWith('doc/') ? cleaned : `doc/${cleaned}`
}

const restAfterBy = (content: string, titleEnd: number): {rest: string} | null => {
  const match = /^\s+by\s+/i.exec(content.slice(titleEnd))
  if (!match) return null
  return {rest: content.slice(titleEnd + match[0].length)}
}

const parseAuthorBeforeMarker = (
  rest: string,
  markerRe: RegExp,
): {author: string, marker: string, afterMarker: string} | null => {
  markerRe.lastIndex = 0
  const match = markerRe.exec(rest)
  if (!match) return null
  const author = rest
    .slice(0, match.index)
    .replace(/\s+/g, ' ')
    .replace(/\s*[•·]\s*$/u, '')
    .trim()
  return {
    author,
    marker: match[0],
    afterMarker: rest.slice(match.index + match[0].length),
  }
}

export const derivePropertiesFromContent = (content: string): ContentDerivedProperties => {
  const properties: Record<string, unknown> = {}
  const diagnostics: string[] = []
  const title = parseLeadingTitle(content)
  if (!title) return {content, properties, diagnostics}

  const by = restAfterBy(content, title.end)
  if (!by) return {content, properties, diagnostics}

  const urls: string[] = []
  const markdownReadwiseUrl = readwiseUrlFromDestination(title.destination)
  pushUrl(urls, markdownReadwiseUrl)

  const exactAuthors = exactAuthorRefs(by.rest.trim())
  if (exactAuthors) {
    if (exactAuthors.length === 1) {
      properties[ROAM_AUTHOR_PROP] = exactAuthors[0]
    } else if (title.label.startsWith('doc/')) {
      diagnostics.push(
        `Readwise author candidate on [[${title.label}]] has ${exactAuthors.length} exact author refs; ` +
        `left roam:author unset.`,
      )
    }
    return {content, properties, diagnostics}
  }
  if (by.rest.trim() === '[[]]' && title.label.startsWith('doc/')) {
    diagnostics.push(
      `Readwise author candidate on [[${title.label}]] had blank [[]] author; ` +
      `left roam:author unset.`,
    )
    return {content, properties, diagnostics}
  }

  const urlMarker = parseAuthorBeforeMarker(by.rest, /(?:^|\s)url:\s*/i)
  if (urlMarker) {
    const author = authorPageRef(urlMarker.author)
    if (author) properties[ROAM_AUTHOR_PROP] = author
    else diagnostics.push(`Readwise author candidate on [[${title.label}]] had blank author before url:.`)
    pushUrl(urls, firstUrl(urlMarker.afterMarker))
    const viaMarker = parseAuthorBeforeMarker(urlMarker.afterMarker, /(?:^|\s)via\s+/i)
    pushUrl(urls, viaMarker ? firstUrl(viaMarker.afterMarker) : undefined)
    setUrlProperties(properties, urls)
    return {content, properties, diagnostics}
  }

  const viaMarker = parseAuthorBeforeMarker(by.rest, /(?:^|\s)via\s+/i)
  if (viaMarker && (markdownReadwiseUrl || title.destination?.includes('read.readwise.io/read'))) {
    const author = authorPageRef(viaMarker.author)
    if (author) properties[ROAM_AUTHOR_PROP] = author
    else diagnostics.push(`Readwise author candidate on [[${title.label}]] had blank author before via.`)
    pushUrl(urls, firstUrl(viaMarker.afterMarker))
    setUrlProperties(properties, urls)
    if (title.kind === 'markdown' && markdownReadwiseUrl) {
      const docAlias = docAliasFromMarkdownLabel(title.label)
      const normalizedContent =
        `${content.slice(0, title.start)}[[${docAlias}]]${content.slice(title.end)}`
      return {content: normalizedContent, properties, diagnostics}
    }
    return {content, properties, diagnostics}
  }

  return {content, properties, diagnostics}
}
