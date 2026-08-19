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
  'move_block',
  'delete_block',
  'restore_block',
] as const

export type KmMcpToolName = (typeof KM_MCP_TOOL_NAMES)[number]

/** Fully-qualified tool ids as they appear to `claude --allowedTools`. */
export const KM_MCP_ALLOWED_TOOLS = KM_MCP_TOOL_NAMES.map(
  name => `mcp__${MCP_SERVER_NAME}__${name}`,
)

/** Canonical strict guard lives in protocol.ts so the bridge server's
 * read-only token scope, app watch-events registration, and MCP server
 * all enforce the same rules. */
export { isReadOnlySql } from './protocol.js'
