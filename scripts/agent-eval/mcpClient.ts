/**
 * The km MCP server and a client to it in one process, over a BridgeClient:
 * the real tools' schema checks and rendering, without spawning `mcp.js`.
 */
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import type { BridgeClient } from '../../packages/agent-cli/src/client'
import { createGraphMcpServer } from '../../packages/agent-cli/src/mcpServer'

export interface McpConnection {
  /** Calls a km MCP tool by name and returns its text output. */
  callTool: (name: string, args: Record<string, unknown>) => Promise<string>
  close: () => Promise<void>
}

export const connectMcpClient = async (bridge: BridgeClient): Promise<McpConnection> => {
  const server = createGraphMcpServer({client: bridge})
  const client = new Client({name: 'agent-eval', version: '0'})
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)])
  return {
    callTool: async (name, args) => {
      const result = await client.callTool({name, arguments: args})
      const text = (result.content as Array<{type: string, text?: string}>).map(part => part.text ?? '').join('')
      if (result.isError) throw new Error(`${name} failed: ${text}`)
      return text
    },
    close: async () => {
      await client.close()
      await server.close()
    },
  }
}
