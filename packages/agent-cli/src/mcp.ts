#!/usr/bin/env node
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { createGraphMcpServer } from './mcpServer.js'

const args = process.argv.slice(2)
const contributorIndex = args.indexOf('--contributor')
if (contributorIndex >= 0 && (!args[contributorIndex + 1] || args[contributorIndex + 2]?.startsWith('--'))) {
  throw new Error('Usage: km-mcp [--contributor <id|none>]')
}
const contributorArg = contributorIndex >= 0 ? args[contributorIndex + 1] : undefined
if (args.some((arg, index) => arg.startsWith('--') && arg !== '--contributor' && index !== contributorIndex + 1)) {
  throw new Error('Usage: km-mcp [--contributor <id|none>]')
}
await createGraphMcpServer({
  ...(contributorArg !== undefined ? {contributorId: contributorArg === 'none' ? null : contributorArg} : {}),
}).connect(new StdioServerTransport())
