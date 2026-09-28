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
import { handleChannelPost } from './channelListener.js'

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
        const {status, body: replyBody} = await handleChannelPost({
          body,
          dedup,
          dispatch: event => server.server.notification({
            method: 'notifications/claude/channel',
            params: event,
          }),
        })
        response.writeHead(status).end(replyBody)
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
