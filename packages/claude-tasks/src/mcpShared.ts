/**
 * Names shared between the MCP server (registration) and the daemon
 * (--allowedTools allowlist + generated --mcp-config). One list so the
 * allowlist can never drift from what the server actually exposes.
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
