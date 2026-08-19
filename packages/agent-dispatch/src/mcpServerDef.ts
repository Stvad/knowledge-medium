import { fileURLToPath } from 'node:url'
import { MCP_SERVER_NAME } from '@knowledge-medium/agent-cli/mcpShared'
import type { DaemonConfig } from './config.js'
import { BLOCKED_WIKILINKS_ENV, encodeBlockedWikilinks } from './blockedWikilinks.js'

/** The dispatch-owned km MCP server definition, shared between claude's
 *  --mcp-config JSON file and codex's `-c mcp_servers.*` overrides —
 *  one source of truth for command/args/env so the two executors can
 *  never drift apart. */
export const buildMcpServerDef = (config: DaemonConfig) => {
  const mcpServerScript = fileURLToPath(new URL('./mcp.js', import.meta.url))
  const blockedTargets = config.watchers
    .filter(watcher => watcher.kind === 'backlinks')
    .map(watcher => watcher.target)

  return {
    name: MCP_SERVER_NAME,
    command: process.execPath,
    args: [mcpServerScript],
    env: {
      AGENT_RUNTIME_PROFILE: config.profile,
      ...(blockedTargets.length > 0 ? {[BLOCKED_WIKILINKS_ENV]: encodeBlockedWikilinks(blockedTargets)} : {}),
    },
  }
}
