import { fileURLToPath } from 'node:url'
import { MCP_SERVER_NAME } from '@knowledge-medium/agent-cli/mcpShared'
import type { DaemonConfig } from './config.js'
import { BLOCKED_WIKILINKS_ENV, encodeBlockedWikilinks } from './blockedWikilinks.js'

/** The workspace root whose files the server's add_media may read (mcp.ts). */
export const MEDIA_ROOT_ENV = 'AGENT_DISPATCH_MEDIA_ROOT'

/** The dispatch-owned km MCP server definition, shared between claude's
 *  --mcp-config JSON file and codex's `-c mcp_servers.*` overrides —
 *  one source of truth for command/args/env so the two executors can
 *  never drift apart. `mediaRoot`: a workspace watcher's root. */
export const buildMcpServerDef = (config: DaemonConfig, contributorId: string | null, mediaRoot?: string) => {
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
      AGENT_RUNTIME_WORKSPACE: config.workspaceId,
      AGENT_RUNTIME_CONTRIBUTOR_ID: contributorId ?? 'none',
      ...(blockedTargets.length > 0 ? {[BLOCKED_WIKILINKS_ENV]: encodeBlockedWikilinks(blockedTargets)} : {}),
      ...(mediaRoot !== undefined ? {[MEDIA_ROOT_ENV]: mediaRoot} : {}),
    },
  }
}
