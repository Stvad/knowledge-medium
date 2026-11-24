/** Names shared by the generic Knowledge Medium graph MCP server and
 * callers that need to construct MCP tool allowlists/config. Every tool a
 * server registers; allowlists derive from it, so they cannot name a tool
 * the server does not know. */
export const MCP_SERVER_NAME = 'km'

export const KM_MCP_TOOL_NAMES = [
  'get_block',
  'subtree',
  'backlinks',
  'grouped_backlinks',
  'page',
  'daily_note',
  'search',
  'memory_index',
  'guide',
  'sql_query',
  'read_media',
  'create_block',
  'update_block',
  'move_block',
  'delete_block',
  'restore_block',
  'append_markdown',
  'edit_block',
  'create_page',
  'add_media',
  'list_contributors',
  'create_contributor',
  'recent_changes',
  'block_history',
  'comments',
  'add_comment',
] as const

export type KmMcpToolName = (typeof KM_MCP_TOOL_NAMES)[number]

const toolId = (name: KmMcpToolName) => `mcp__${MCP_SERVER_NAME}__${name}`

/** Fully-qualified tool ids as they appear to `claude --allowedTools`. `add_media` is left
 *  out: on a server with `localMediaFiles` it uploads any local file the model names. */
export const KM_MCP_ALLOWED_TOOLS = KM_MCP_TOOL_NAMES.filter(name => name !== 'add_media').map(toolId)

/** Every tool, for a server WITHOUT `localMediaFiles`, whose `add_media` stores only
 *  bytes the model passes in. */
export const KM_MCP_ALLOWED_TOOLS_WITHOUT_LOCAL_FILES = KM_MCP_TOOL_NAMES.map(toolId)

/** Canonical strict guard lives in protocol.ts so the bridge server's
 * read-only token scope, app watch-events registration, and MCP server
 * all enforce the same rules. */
export { isReadOnlySql } from './protocol.js'
