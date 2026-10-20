#!/usr/bin/env node
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { createGraphMcpServer } from './mcpServer.js'

const args = process.argv.slice(2)
let contributorArg: string | undefined
for (let index = 0; index < args.length; index += 1) {
  const arg = args[index]
  if (arg !== '--contributor' || contributorArg !== undefined) {
    throw new Error('Usage: km-mcp [--contributor <id|none>]')
  }
  const value = args[index + 1]
  if (!value || value.startsWith('-')) {
    throw new Error('Usage: km-mcp [--contributor <id|none>]')
  }
  contributorArg = value
  index += 1
}
await createGraphMcpServer({
  ...(contributorArg !== undefined ? {contributorId: contributorArg === 'none' ? null : contributorArg} : {}),
}).connect(new StdioServerTransport())
