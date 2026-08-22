#!/usr/bin/env node
/**
 * Dispatch channel MCP entrypoint. Graph tools are registered by the
 * generic @knowledge-medium/agent-cli MCP server factory; this wrapper
 * adds dispatch-owned write policy plus the experimental Claude Code
 * channel listener used by delivery: "channel" watchers.
 */
import http from 'node:http'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { createGraphMcpServer } from '@knowledge-medium/agent-cli/mcpServer'
import { BLOCKED_WIKILINKS_ENV, createBlockedWikilinkWriteGuard, decodeBlockedWikilinks } from './blockedWikilinks.js'
import { CHANNEL_PORT_ENV, CHANNEL_SECRET_HEADER, loadOrCreateChannelSecret } from './channelSecret.js'
import { createDeliveryDedup } from './deliveryDedup.js'

const channelPort = Number(process.env[CHANNEL_PORT_ENV] ?? '') || null
const blockedWikilinks = decodeBlockedWikilinks(process.env[BLOCKED_WIKILINKS_ENV])

const server = createGraphMcpServer({
  writeGuard: ({graph}) => createBlockedWikilinkWriteGuard(graph, blockedWikilinks),
  serverOptions: channelPort
    ? {
        capabilities: {experimental: {'claude/channel': {}}, tools: {}},
        instructions:
          'Events from the km channel arrive as <channel source="km" ...> — tasks from the user\'s '
          + 'Knowledge Medium notes. Each event says how to close its task out (reply block + status '
          + 'properties) using the km tools in this server.',
      }
    : undefined,
})

await server.connect(new StdioServerTransport())

// ----- experimental channel listener ---------------------------------
// Loopback + shared-secret auth (the bridge itself is loopback + bearer
// token; loopback alone stops nothing running on this machine, nor
// no-preflight browser POSTs). Strict JSON content-type and an empty
// Origin are additional belts against cross-site injection.
if (channelPort) {
  const secret = await loadOrCreateChannelSecret()

  const dedup = createDeliveryDedup()

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
          // The notification STARTS the ambient session working, and only
          // then do we acknowledge — so a lost ack leaves the sender unable
          // to tell "never arrived" from "already running", and its retry
          // would duplicate billed, write-capable agent work on the graph.
          // Dropping a repeat of an id we have already dispatched is what
          // makes that retry safe.
          //
          // Best-effort, not exactly-once: the window is bounded by
          // DELIVERED_IDS_MAX and a restart of this process forgets
          // everything. It covers the retry window, which is the case that
          // actually occurs; a sender with no id is never deduplicated.
          // Claimed BEFORE the await below, not after: `notification` waits
          // for the stdio transport to drain, and that wait can outlast the
          // sender's 10s timeout. Claiming afterwards left the first request
          // in flight with nothing claimed, so the retry sailed past this
          // check and queued the SAME notification again — both landing when
          // stdout drained, and the session doing the work twice.
          const outcome = dedup.claim(meta?.event_id)
          if (outcome === 'delivered') {
            response.writeHead(200).end('duplicate')
            return
          }
          if (outcome === 'unconfirmed') {
            // Someone holds this id and has not confirmed. Answering 200
            // would tell a query sender its rows are with the session, and
            // it would then advance its cursor past work that may never have
            // run — with no block left behind for a sweep to find. 503 says
            // "unknown, ask again", which its retry path already handles.
            response.writeHead(503).end('in flight')
            return
          }
          // The claim is NOT released if this throws. Once the write has
          // begun there is no way to know from here whether the session saw
          // it, and this system prefers work that needs re-triggering over
          // work that runs twice: the sender's retry is answered
          // `duplicate`, the block stays `running`, and the stale sweep
          // re-queues it under a fresh id — the documented recovery.
          await server.server.notification({
            method: 'notifications/claude/channel',
            params: {content: parsed.content, ...(meta ? {meta} : {})},
          })
          // Confirmed only once the write has completed. Until then the claim
          // reads `unconfirmed`, so nobody may bank on it.
          dedup.confirm(meta?.event_id)
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
    process.stderr.write(`km dispatch channel listener failed: ${error instanceof Error ? error.message : String(error)}\n`)
  })
  listener.listen(channelPort, '127.0.0.1')
}
