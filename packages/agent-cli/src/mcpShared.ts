/** Names shared by the generic Knowledge Medium graph MCP server and
 * callers that need to construct MCP tool allowlists/config. One list
 * so caller allowlists can never drift from what the server exposes. */
export const MCP_SERVER_NAME = 'km'

export const KM_MCP_TOOL_NAMES = [
  'get_block',
  'subtree',
  'backlinks',
  'page',
  'daily_note',
  'search',
  'sql_query',
  'create_block',
  'update_block',
] as const

export type KmMcpToolName = (typeof KM_MCP_TOOL_NAMES)[number]

/** Fully-qualified tool ids as they appear to `claude --allowedTools`. */
export const KM_MCP_ALLOWED_TOOLS = KM_MCP_TOOL_NAMES.map(
  name => `mcp__${MCP_SERVER_NAME}__${name}`,
)

/** Optional env var for MCP server instances: page aliases whose
 *  wikilinks the write tools must refuse to create. JSON-array encoded;
 *  a legacy comma-separated value is also accepted. */
export const BLOCKED_WIKILINKS_ENV = 'KM_MCP_BLOCKED_WIKILINKS'

export const encodeBlockedWikilinks = (names: string[]): string => JSON.stringify(names)

/** Decode the env value. JSON-array form is lossless; the legacy
 *  comma-separated form can't represent names containing commas (they
 *  split into fragments and the guard resolves the wrong pages). */
export const decodeBlockedWikilinks = (value: string | undefined): string[] => {
  const raw = (value ?? '').trim()
  if (!raw) return []
  if (raw.startsWith('[')) {
    try {
      const parsed: unknown = JSON.parse(raw)
      if (Array.isArray(parsed)) {
        return parsed.filter((name): name is string => typeof name === 'string' && name.length > 0)
      }
    } catch {
      // fall through to the legacy form
    }
  }
  return raw.split(',').map(name => name.trim()).filter(Boolean)
}

// ----- pure guards (here, not in mcp.ts, so tests can import them
// without executing the server entrypoint) ----------------------------

export interface RefGuardSet {
  aliases: string[]
  ids: string[]
}

/** First blocked reference found in content, or null. Case-insensitive;
 *  `((id))` is a substring of the `!((id))` embed and `[label](((id)))`
 *  forms, so one check covers every block-ref syntax. */
export const findBlockedRef = (content: string, guard: RefGuardSet): string | null => {
  // NFC on BOTH sides so normalization form can't split the comparison —
  // the app resolves composed and decomposed aliases as the same page.
  const lower = content.normalize('NFC').toLowerCase()
  for (const alias of guard.aliases) {
    if (lower.includes(`[[${alias.normalize('NFC').toLowerCase()}]]`)) return `[[${alias}]]`
  }
  for (const id of guard.ids) {
    if (lower.includes(`((${id.toLowerCase()}))`)) return `((${id}))`
  }
  return null
}

/** First blocked reference reachable through a properties map, or null.
 *  A ref-typed property whose VALUE is a watched page's id projects a
 *  backlink with no `[[...]]` in content (referenceProjection.ts), so
 *  the content guard alone is bypassable. We don't have the property
 *  schemas here, so scan every stringified value for a blocked id as a
 *  bare substring (the raw form a ref codec stores) plus the content
 *  ref forms — conservative on purpose: over-blocking a property that
 *  merely contains the id as text is the safe direction for a
 *  re-trigger guard. */
export const findBlockedRefInProperties = (
  properties: Record<string, unknown> | undefined,
  guard: RefGuardSet,
): string | null => {
  if (!properties) return null
  const blob = JSON.stringify(properties).normalize('NFC').toLowerCase()
  const contentHit = findBlockedRef(blob, guard)
  if (contentHit) return contentHit
  for (const id of guard.ids) {
    if (blob.includes(id.toLowerCase())) return id
  }
  return null
}

/** Canonical strict guard lives in protocol.ts so the bridge server's
 * read-only token scope, app watch-events registration, and MCP server
 * all enforce the same rules. */
export { isReadOnlySql } from './protocol.js'
