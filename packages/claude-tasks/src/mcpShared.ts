/**
 * Names shared between the MCP server (registration) and the daemon
 * (--allowedTools allowlist + generated --mcp-config). One list so the
 * allowlist can never drift from what the server actually exposes —
 * mcp.ts pins every registration with `satisfies KmMcpToolName`.
 */
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

/** Env var the daemon sets in the generated MCP config: comma-separated
 *  page aliases whose wikilinks the MCP write tools must refuse to
 *  create (defense-in-depth against watcher re-trigger loops). */
export const BLOCKED_WIKILINKS_ENV = 'KM_MCP_BLOCKED_WIKILINKS'

/** EXPERIMENTAL (Claude Code channels research preview): when set, the
 *  km MCP server declares the channel capability and binds a loopback
 *  HTTP listener on this port for event injection. */
export const CHANNEL_PORT_ENV = 'KM_MCP_CHANNEL_PORT'

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
  // NFC so a decomposed alias in the write can't slip past a composed
  // alias in the guard (or vice-versa) — the app resolves them as equal.
  const lower = content.normalize('NFC').toLowerCase()
  for (const alias of guard.aliases) {
    if (lower.includes(`[[${alias.toLowerCase()}]]`)) return `[[${alias}]]`
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

/** Side-effecting SQL functions PowerSync registers on the SAME wa-sqlite
 *  connection the bridge uses — `SELECT powersync_clear(1)` wipes local
 *  (incl. un-uploaded) data, `powersync_replace_schema` / `_control`
 *  corrupt schema/sync state. A `SELECT` prologue does NOT make a
 *  statement read-only here, so these must be denied regardless of
 *  prologue. Match the bare `powersync_` TOKEN, not `powersync_` + `(`:
 *  a SQLite comment counts as whitespace, so a comment wedged between the
 *  name and its paren makes a valid call that a `\s*\(` guard would miss
 *  — but the function name itself must appear as one contiguous
 *  identifier to be callable (a comment can't split it), so the bare
 *  token match is comment-proof. The app registers no other writable
 *  UDFs (verified), so this family is the whole vector. */
const SIDE_EFFECTING_FN = /\bpowersync_/i

/** The bridge's sql modes don't gate writes (an UPDATE "runs" under
 *  mode=all), so read-only is enforced textually: single statement, no
 *  side-effecting function call, and either a SELECT/PRAGMA-info/EXPLAIN
 *  prologue or a WITH containing no mutating keyword — CTEs can head
 *  `WITH … UPDATE/INSERT/DELETE`, so `with` alone proves nothing. The
 *  keyword/function scan can false-positive on string literals; rewrite
 *  the query (or use the write tools) in that case. */
export const isReadOnlySql = (sql: string): boolean => {
  const body = sql.trim().replace(/;\s*$/, '')
  if (body.includes(';')) return false
  if (SIDE_EFFECTING_FN.test(body)) return false
  if (/^(select|pragma table_info|explain)\b/i.test(body)) return true
  if (/^with\b/i.test(body)) {
    return !/\b(insert|update|delete|replace|drop|alter|create|vacuum|attach|detach|reindex)\b/i.test(body)
  }
  return false
}
