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
  const lower = content.toLowerCase()
  for (const alias of guard.aliases) {
    if (lower.includes(`[[${alias.toLowerCase()}]]`)) return `[[${alias}]]`
  }
  for (const id of guard.ids) {
    if (lower.includes(`((${id.toLowerCase()}))`)) return `((${id}))`
  }
  return null
}

/** The bridge's sql modes don't gate writes (an UPDATE "runs" under
 *  mode=all), so read-only is enforced textually: single statement, and
 *  either a SELECT/PRAGMA-info/EXPLAIN prologue (which SQLite cannot
 *  turn mutating) or a WITH containing no mutating keyword — CTEs can
 *  head `WITH … UPDATE/INSERT/DELETE`, so `with` alone proves nothing.
 *  The keyword scan can false-positive on string literals; rewrite the
 *  query (or use the write tools) in that case. */
export const isReadOnlySql = (sql: string): boolean => {
  const body = sql.trim().replace(/;\s*$/, '')
  if (body.includes(';')) return false
  if (/^(select|pragma table_info|explain)\b/i.test(body)) return true
  if (/^with\b/i.test(body)) {
    return !/\b(insert|update|delete|replace|drop|alter|create|vacuum|attach|detach|reindex)\b/i.test(body)
  }
  return false
}
