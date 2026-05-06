import { parseReferences } from '@/utils/referenceParser'

const NS_PREFIX = 'roam'
export const ROAM_PAGE_ALIAS_PROP = `${NS_PREFIX}:page_alias`
export const ROAM_AUTHOR_PROP = `${NS_PREFIX}:author`
export const ROAM_ISA_PROP = `${NS_PREFIX}:isa`

export const uniqueStrings = (values: readonly string[]): string[] => {
  const out: string[] = []
  const seen = new Set<string>()
  for (const value of values) {
    const trimmed = value.trim()
    if (!trimmed || seen.has(trimmed)) continue
    seen.add(trimmed)
    out.push(trimmed)
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

export const PAGE_TOKEN_RE = /\[\[([^\]]+)\]\]/g
const PAGE_LIST_VALUE_RE = /^[\s,;]*(\[\[[^\]]+\]\][\s,;]*)+$/

export const explodePageTokens = (value: string): string[] | null => {
  if (!PAGE_LIST_VALUE_RE.test(value)) return null
  const out: string[] = []
  PAGE_TOKEN_RE.lastIndex = 0
  let m: RegExpExecArray | null
  while ((m = PAGE_TOKEN_RE.exec(value)) !== null) out.push(`[[${m[1]}]]`)
  // Single token: not really a "list", let the caller keep the scalar.
  if (out.length < 2) return null
  return out
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
      PAGE_TOKEN_RE.lastIndex = 0
      let m: RegExpExecArray | null
      while ((m = PAGE_TOKEN_RE.exec(v)) !== null) out.add(m[1])
    } else if (Array.isArray(v)) {
      for (const item of v) visit(item)
    }
  }
  for (const v of Object.values(promoted)) visit(v)
  return [...out]
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

export const collectPageAliases = (properties: Record<string, unknown>): string[] =>
  uniqueStrings(collectAliasesFromPropertyValues({
    [ROAM_PAGE_ALIAS_PROP]: properties[ROAM_PAGE_ALIAS_PROP],
  }))

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
    PAGE_TOKEN_RE.lastIndex = 0
    if (!PAGE_TOKEN_RE.test(trimmed)) out.push(trimmed)
  }
  return out
}

export const derivePropertiesFromContent = (content: string): Record<string, unknown> => {
  const match = /^\s*\[\[[^\]]+\]\]\s+by\s+(.+?)\s*$/i.exec(content)
  if (!match) return {}

  const authors = parseReferences(match[1]).map(ref => `[[${ref.alias}]]`)
  if (authors.length === 0) return {}

  return {
    [ROAM_AUTHOR_PROP]: authors.length === 1 ? authors[0] : authors,
  }
}
