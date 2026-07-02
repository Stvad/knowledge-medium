#!/usr/bin/env node
/**
 * km MCP server — live Knowledge Medium graph tools over the kmagent
 * bridge, for any MCP client: the claude-tasks daemon passes it via
 * --mcp-config to spawned runs; Claude Desktop / interactive Claude
 * Code can register it directly.
 *
 * Deliberately narrower than the bridge: read tools + block-level
 * writes only. No eval, no sql execute, no extension lifecycle — a
 * spawned model gets graph access, not a JS interpreter in the app.
 *
 * Env:
 * - AGENT_RUNTIME_PROFILE: kmagent token profile (default "default")
 * - KM_MCP_BLOCKED_WIKILINKS: comma-separated page aliases the write
 *   tools refuse to reference (watcher re-trigger guard, set by the
 *   daemon). Enforced against ALL reference syntaxes: each name is
 *   resolved to its page, and that page's full alias set plus its id
 *   ([[any-alias]], ((id)), (((id))) embeds/labels) is blocked.
 * - KM_MCP_CHANNEL_PORT (EXPERIMENTAL): when set, the server also
 *   declares the Claude Code `claude/channel` capability (research
 *   preview) and binds a loopback HTTP listener on this port; POSTed
 *   {content, meta?} bodies are pushed into the hosting session as
 *   `notifications/claude/channel` events. Requests must carry the
 *   shared secret (x-km-channel-secret, from the 0600 secret file) —
 *   loopback alone is NOT an auth boundary. Only meaningful when the
 *   session was started with
 *   `claude --dangerously-load-development-channels server:km`.
 */
import http from 'node:http'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { z } from 'zod'
import { createBridgeClient } from '@knowledge-medium/agent-cli/client'
import { renderSubtreeOutline, type SubtreeOutlineRow } from '@knowledge-medium/agent-cli/subtreeOutline'
import { createGraph } from './graph.js'
import { BLOCKED_WIKILINKS_ENV, CHANNEL_PORT_ENV, findBlockedRef, findBlockedRefInProperties, isReadOnlySql, type KmMcpToolName, MCP_SERVER_NAME, type RefGuardSet } from './mcpShared.js'
import { CHANNEL_SECRET_HEADER, loadOrCreateChannelSecret } from './channelSecret.js'

const client = createBridgeClient({
  profile: process.env.AGENT_RUNTIME_PROFILE,
  timeoutMs: 60_000,
})
const graph = createGraph(client)

// ----- write guard: watcher re-trigger prevention ---------------------

const blockedNames = (process.env[BLOCKED_WIKILINKS_ENV] ?? '')
  .split(',')
  .map(alias => alias.trim())
  .filter(Boolean)

let guardCache: {set: RefGuardSet, fetchedAt: number} | null = null
const GUARD_TTL_MS = 10 * 60_000

/** Resolve the blocked names to their pages' FULL alias sets + ids via
 *  the bridge (lazily, cached). A guard that only blocks the literal
 *  configured string is trivially bypassed with `((page-id))` or any
 *  other alias of the same page. Falls back to the raw names when a
 *  page can't be resolved (it may not exist yet). */
const guardSet = async (): Promise<RefGuardSet> => {
  if (blockedNames.length === 0) return {aliases: [], ids: []}
  if (guardCache && Date.now() - guardCache.fetchedAt < GUARD_TTL_MS) return guardCache.set

  const aliases = new Set(blockedNames)
  const ids = new Set<string>()
  let complete = true
  for (const name of blockedNames) {
    try {
      const target = await graph.targetGuardSet(name)
      ids.add(target.id)
      for (const alias of target.aliases) aliases.add(alias)
    } catch {
      // Page missing / bridge hiccup: fall back to the raw-name guard,
      // but do NOT cache a partial fill — otherwise an id/alias bypass
      // would be open for the whole TTL. Retry on the next call.
      complete = false
    }
  }
  const set = {aliases: [...aliases], ids: [...ids]}
  if (complete) guardCache = {set, fetchedAt: Date.now()}
  return set
}

const assertNoBlockedRefs = async (
  content: string | undefined,
  properties?: Record<string, unknown>,
) => {
  if (blockedNames.length === 0) return
  if (!content && !properties) return
  const guard = await guardSet()
  const blocked =
    (content ? findBlockedRef(content, guard) : null)
    ?? findBlockedRefInProperties(properties, guard)
  if (blocked) {
    throw new Error(
      `Refusing to write "${blocked}": it references a watcher-target page and would re-trigger the watcher that spawned this run. Refer to the page without linking it.`,
    )
  }
}

const json = (value: unknown) => ({
  content: [{type: 'text' as const, text: JSON.stringify(value, null, 2)}],
})
const text = (value: string) => ({
  content: [{type: 'text' as const, text: value}],
})

const channelPort = Number(process.env[CHANNEL_PORT_ENV] ?? '') || null

const server = new McpServer(
  {name: MCP_SERVER_NAME, version: '0.1.0'},
  channelPort
    ? {
        capabilities: {experimental: {'claude/channel': {}}, tools: {}},
        instructions:
          'Events from the km channel arrive as <channel source="km" ...> — tasks from the user\'s '
          + 'Knowledge Medium notes. Each event says how to close its task out (reply block + status '
          + 'properties) using the km tools in this server.',
      }
    : undefined,
)

server.registerTool('get_block' satisfies KmMcpToolName, {
  description: 'Fetch a single block (content, properties, parentId) by id. For its children, use the subtree tool.',
  inputSchema: {id: z.string()},
}, async ({id}) => json(await graph.getBlock(id)))

server.registerTool('subtree' satisfies KmMcpToolName, {
  description: 'Fetch the subtree under a block as a depth-indented outline (one line per block: `- [<id>] <content>`).',
  inputSchema: {rootId: z.string()},
}, async ({rootId}) =>
  text(renderSubtreeOutline(await graph.getSubtree(rootId) as SubtreeOutlineRow[])))

server.registerTool('backlinks' satisfies KmMcpToolName, {
  description: 'List blocks that reference the given block/page (hydrated: id, content, deepLink).',
  inputSchema: {id: z.string()},
}, async ({id}) => json(await graph.backlinkSources(id)))

server.registerTool('page' satisfies KmMcpToolName, {
  description: 'Resolve a page by alias/title. Returns the exact match (if any) plus substring candidates.',
  inputSchema: {name: z.string()},
}, async ({name}) => json(await client.runCommand({type: 'page', name})))

server.registerTool('daily_note' satisfies KmMcpToolName, {
  description: 'Resolve a date expression (today | yesterday | ISO date | natural language) to its daily-note block.',
  inputSchema: {date: z.string()},
}, async ({date}) => json(await client.runCommand({type: 'daily-note', date})))

server.registerTool('search' satisfies KmMcpToolName, {
  description: 'Full-text search over block content.',
  inputSchema: {query: z.string(), limit: z.number().int().positive().optional()},
}, async ({query, limit}) => json(await client.runCommand({type: 'search', query, limit})))

server.registerTool('sql_query' satisfies KmMcpToolName, {
  description: 'Run a read-only SQL query (single SELECT/WITH statement) against the client database. Key tables: blocks(id, content, properties_json, parent_id, workspace_id).',
  inputSchema: {sql: z.string(), params: z.array(z.unknown()).optional()},
}, async ({sql, params}) => {
  if (!isReadOnlySql(sql)) {
    throw new Error('sql_query only accepts a single read-only statement (SELECT, or WITH without mutating keywords). Use create_block / update_block for writes.')
  }
  return json(await graph.sqlAll(sql, params ?? []))
})

server.registerTool('create_block' satisfies KmMcpToolName, {
  description: 'Create a new block under a parent. Content is markdown; [[Page]] wikilinks create references.',
  inputSchema: {
    parentId: z.string(),
    content: z.string(),
    properties: z.record(z.string(), z.unknown()).optional(),
  },
}, async ({parentId, content, properties}) => {
  await assertNoBlockedRefs(content, properties)
  return json(await client.runCommand({type: 'create-block', parentId, content, properties}))
})

server.registerTool('update_block' satisfies KmMcpToolName, {
  description: 'Update a block\'s content and/or merge properties.',
  inputSchema: {
    id: z.string(),
    content: z.string().optional(),
    properties: z.record(z.string(), z.unknown()).optional(),
  },
}, async ({id, content, properties}) => {
  await assertNoBlockedRefs(content, properties)
  return json(await client.runCommand({type: 'update-block', id, content, properties}))
})

await server.connect(new StdioServerTransport())

// ----- experimental channel listener ---------------------------------
// Loopback + shared-secret auth (the bridge itself is loopback + bearer
// token; loopback alone stops nothing running on this machine, nor
// no-preflight browser POSTs). Strict JSON content-type and an empty
// Origin are additional belts against cross-site injection.
if (channelPort) {
  const secret = await loadOrCreateChannelSecret()

  const listener = http.createServer((request, response) => {
    if (request.method !== 'POST') {
      response.writeHead(405).end()
      return
    }
    if (request.headers[CHANNEL_SECRET_HEADER] !== secret) {
      response.writeHead(401).end('missing or wrong x-km-channel-secret')
      return
    }
    if (!request.headers['content-type']?.includes('application/json') || request.headers.origin) {
      response.writeHead(400).end('expected non-browser application/json request')
      return
    }
    let body = ''
    request.on('data', chunk => { body += chunk })
    request.on('end', () => {
      void (async () => {
        try {
          const parsed = JSON.parse(body) as {content?: unknown, meta?: unknown}
          if (typeof parsed.content !== 'string') throw new Error('content required')
          const meta = parsed.meta && typeof parsed.meta === 'object'
            ? Object.fromEntries(
                Object.entries(parsed.meta as Record<string, unknown>)
                  .filter(([, value]) => typeof value === 'string'),
              ) as Record<string, string>
            : undefined
          await server.server.notification({
            method: 'notifications/claude/channel',
            params: {content: parsed.content, ...(meta ? {meta} : {})},
          })
          response.writeHead(200).end('ok')
        } catch {
          response.writeHead(400).end('expected JSON {content, meta?}')
        }
      })()
    })
  })
  // EADDRINUSE (e.g. two sessions loading the same .mcp.json) must not
  // take the graph tools down with it — log and carry on without the
  // listener.
  listener.on('error', error => {
    process.stderr.write(`km channel listener failed: ${error instanceof Error ? error.message : String(error)}\n`)
  })
  listener.listen(channelPort, '127.0.0.1')
}
