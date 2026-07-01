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
 * - KM_MCP_BLOCKED_WIKILINKS: comma-separated aliases the write tools
 *   refuse to link (watcher re-trigger guard, set by the daemon)
 * - KM_MCP_CHANNEL_PORT (EXPERIMENTAL): when set, the server also
 *   declares the Claude Code `claude/channel` capability (research
 *   preview) and binds a loopback HTTP listener on this port; POSTed
 *   {content, meta?} bodies are pushed into the hosting session as
 *   `notifications/claude/channel` events. Only meaningful when the
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
import { BLOCKED_WIKILINKS_ENV, CHANNEL_PORT_ENV, MCP_SERVER_NAME } from './mcpShared.js'

const client = createBridgeClient({
  profile: process.env.AGENT_RUNTIME_PROFILE,
  timeoutMs: 60_000,
})
const graph = createGraph(client)

const blockedWikilinks = (process.env[BLOCKED_WIKILINKS_ENV] ?? '')
  .split(',')
  .map(alias => alias.trim())
  .filter(Boolean)

const assertNoBlockedWikilinks = (content: string | undefined) => {
  if (!content) return
  for (const alias of blockedWikilinks) {
    if (content.toLowerCase().includes(`[[${alias.toLowerCase()}]]`)) {
      throw new Error(
        `Refusing to write "[[${alias}]]": that wikilink re-triggers the watcher that spawned this run. Refer to the page without linking it.`,
      )
    }
  }
}

/** Only statements that cannot mutate. The bridge's sql modes don't
 *  gate writes by themselves (an UPDATE "runs" under mode=all), so the
 *  read-only guarantee is enforced here, textually. */
const READ_ONLY_SQL = /^\s*(select|with|pragma table_info|explain)\b/i

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

server.registerTool('get_block', {
  description: 'Fetch a single block (content, properties, parentId, childIds) by id.',
  inputSchema: {id: z.string()},
}, async ({id}) => json(await graph.getBlock(id)))

server.registerTool('subtree', {
  description: 'Fetch the subtree under a block as a depth-indented outline (one line per block: `- [<id>] <content>`).',
  inputSchema: {rootId: z.string()},
}, async ({rootId}) =>
  text(renderSubtreeOutline(await graph.getSubtree(rootId) as SubtreeOutlineRow[])))

server.registerTool('backlinks', {
  description: 'List blocks that reference the given block/page (hydrated: id, content, deepLink).',
  inputSchema: {id: z.string()},
}, async ({id}) => json(await graph.backlinkSources(id)))

server.registerTool('page', {
  description: 'Resolve a page by alias/title. Returns the exact match (if any) plus substring candidates.',
  inputSchema: {name: z.string()},
}, async ({name}) => json(await client.runCommand({type: 'page', name})))

server.registerTool('daily_note', {
  description: 'Resolve a date expression (today | yesterday | ISO date | natural language) to its daily-note block.',
  inputSchema: {date: z.string()},
}, async ({date}) => json(await client.runCommand({type: 'daily-note', date})))

server.registerTool('search', {
  description: 'Full-text search over block content.',
  inputSchema: {query: z.string(), limit: z.number().int().positive().optional()},
}, async ({query, limit}) => json(await client.runCommand({type: 'search', query, limit})))

server.registerTool('sql_query', {
  description: 'Run a read-only SQL query (SELECT/WITH) against the client database. Key tables: blocks(id, content, properties_json, parent_id, workspace_id).',
  inputSchema: {sql: z.string(), params: z.array(z.unknown()).optional()},
}, async ({sql, params}) => {
  if (!READ_ONLY_SQL.test(sql)) {
    throw new Error('sql_query only accepts read-only statements (SELECT / WITH). Use create_block / update_block for writes.')
  }
  return json(await graph.sqlAll(sql, params ?? []))
})

server.registerTool('create_block', {
  description: 'Create a new block under a parent. Content is markdown; [[Page]] wikilinks create references.',
  inputSchema: {
    parentId: z.string(),
    content: z.string(),
    properties: z.record(z.string(), z.unknown()).optional(),
  },
}, async ({parentId, content, properties}) => {
  assertNoBlockedWikilinks(content)
  return json(await client.runCommand({type: 'create-block', parentId, content, properties}))
})

server.registerTool('update_block', {
  description: 'Update a block\'s content and/or merge properties.',
  inputSchema: {
    id: z.string(),
    content: z.string().optional(),
    properties: z.record(z.string(), z.unknown()).optional(),
  },
}, async ({id, content, properties}) => {
  assertNoBlockedWikilinks(content)
  return json(await client.runCommand({type: 'update-block', id, content, properties}))
})

await server.connect(new StdioServerTransport())

// ----- experimental channel listener ---------------------------------
// Loopback-only, mirrors the bridge's posture. The daemon (or curl)
// POSTs {content, meta?}; each becomes a channel event in the hosting
// session. Notifications are fire-and-forget per the channels contract.
if (channelPort) {
  const listener = http.createServer((request, response) => {
    if (request.method !== 'POST') {
      response.writeHead(405).end()
      return
    }
    let body = ''
    request.on('data', chunk => { body += chunk })
    request.on('end', () => {
      void (async () => {
        try {
          const parsed = JSON.parse(body) as {content?: unknown, meta?: unknown}
          const content = typeof parsed.content === 'string' ? parsed.content : body
          const meta = parsed.meta && typeof parsed.meta === 'object'
            ? Object.fromEntries(
                Object.entries(parsed.meta as Record<string, unknown>)
                  .filter(([, value]) => typeof value === 'string'),
              ) as Record<string, string>
            : undefined
          await server.server.notification({
            method: 'notifications/claude/channel',
            params: {content, ...(meta ? {meta} : {})},
          })
          response.writeHead(200).end('ok')
        } catch {
          response.writeHead(400).end('expected JSON {content, meta?}')
        }
      })()
    })
  })
  listener.listen(channelPort, '127.0.0.1')
}
