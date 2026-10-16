import {describe, expect, it, vi} from 'vitest'
import type {CallToolResult} from '@modelcontextprotocol/sdk/types.js'
import fs from 'node:fs/promises'
import path from 'node:path'
import {fileURLToPath} from 'node:url'
import type {BridgeClient} from '../src/client'
import type {KnownCommand} from '../src/protocol'
import {createGraphMcpServer, KM_MCP_INSTRUCTIONS, type GraphMcpWriteOperation} from '../src/mcpServer'
import {KM_MCP_TOOL_NAMES} from '../src/mcpShared'

const here = path.dirname(fileURLToPath(import.meta.url))
const packageJsonPath = path.resolve(here, '../package.json')

interface RegisteredToolHarness {
  _registeredTools: Record<string, {
    handler: (
      args: Record<string, unknown>,
      extra: Record<string, never>,
    ) => CallToolResult | Promise<CallToolResult>
  }>
}

interface ServerInfoHarness {
  server: {
    _instructions?: string
    _serverInfo: {
      version: string
    }
  }
}

const clientFrom = (
  runCommand: BridgeClient['runCommand'],
): BridgeClient => ({
  bridgeUrl: 'http://agent.test',
  runCommand,
  nextEvents: async () => ({events: [], nextSeq: 0}),
  whoami: async () => ({
    clientId: 'client-1',
    audience: {userId: null, workspaceId: null, label: 'test'},
    scope: 'read-write',
    connected: true,
    clientLastSeen: Date.now(),
  }),
  health: async () => {},
  resolveToken: async () => 'token',
})

describe('createGraphMcpServer', () => {
  it('advertises the package version in MCP server metadata', async () => {
    const raw = await fs.readFile(packageJsonPath, 'utf8')
    const pkg = JSON.parse(raw) as {version: string}
    const client = clientFrom(async command => {
      throw new Error(`Unexpected command: ${command.type}`)
    })
    const server = createGraphMcpServer({
      client,
      serverOptions: {capabilities: {tools: {}}},
    })

    expect((server as unknown as ServerInfoHarness).server._serverInfo.version).toBe(pkg.version)
  })

  it('runs the optional write guard before mutating tools', async () => {
    const commands: KnownCommand[] = []
    const operations: GraphMcpWriteOperation[] = []
    const client = clientFrom(async command => {
      commands.push(command)
      switch (command.type) {
        case 'create-block':
          return {id: 'created'}
        case 'update-block':
          return {id: command.id, content: command.content}
        case 'move-block':
          return {id: command.id, parentId: command.parentId}
        case 'delete-block':
          return {id: command.id, deleted: true}
        case 'restore-block':
          return {id: command.id, content: 'restored'}
        default:
          throw new Error(`Unexpected command: ${command.type}`)
      }
    })
    const server = createGraphMcpServer({
      client,
      writeGuard: {
        beforeWrite: operation => {
          operations.push(operation)
        },
      },
      serverOptions: {capabilities: {tools: {}}},
    })
    const tools = (server as unknown as RegisteredToolHarness)._registeredTools

    await tools.create_block.handler({parentId: 'p', content: 'hi', properties: {x: 1}}, {})
    await tools.update_block.handler({id: 'b', content: 'edited'}, {})
    await tools.move_block.handler({id: 'b', parentId: null, position: {kind: 'last'}}, {})
    await tools.delete_block.handler({id: 'b'}, {})
    await tools.restore_block.handler({id: 'b'}, {})

    expect(operations).toEqual([
      {type: 'create_block', parentId: 'p', content: 'hi', properties: {x: 1}},
      {type: 'update_block', id: 'b', content: 'edited', properties: undefined},
      {type: 'move_block', id: 'b', parentId: null, position: {kind: 'last'}},
      {type: 'delete_block', id: 'b'},
      {type: 'restore_block', id: 'b'},
    ])
    expect(commands.map(command => command.type)).toEqual([
      'create-block',
      'update-block',
      'move-block',
      'delete-block',
      'restore-block',
    ])
  })

  it('does not call the bridge when the write guard rejects', async () => {
    const runCommand = vi.fn<BridgeClient['runCommand']>()
    const client = clientFrom(runCommand)
    const server = createGraphMcpServer({
      client,
      writeGuard: {
        beforeWrite: () => {
          throw new Error('blocked by caller policy')
        },
      },
      serverOptions: {capabilities: {tools: {}}},
    })
    const tools = (server as unknown as RegisteredToolHarness)._registeredTools

    await expect(tools.update_block.handler({id: 'b', content: 'edited'}, {}))
      .rejects.toThrow('blocked by caller policy')
    expect(runCommand).not.toHaveBeenCalled()
  })

  it('registers exactly the advertised tool names', () => {
    const server = createGraphMcpServer({
      client: clientFrom(vi.fn<BridgeClient['runCommand']>()),
      serverOptions: {capabilities: {tools: {}}},
    })
    const tools = (server as unknown as RegisteredToolHarness)._registeredTools
    expect(new Set(Object.keys(tools))).toEqual(new Set(KM_MCP_TOOL_NAMES))
  })

  it('forwards read tools as view commands and returns the app text verbatim', async () => {
    const runCommand = vi.fn<BridgeClient['runCommand']>(async () => '- hello  ^abc')
    const server = createGraphMcpServer({
      client: clientFrom(runCommand),
      serverOptions: {capabilities: {tools: {}}},
    })
    const tools = (server as unknown as RegisteredToolHarness)._registeredTools

    const block = await tools.get_block.handler({ref: 'today'}, {})
    const outline = await tools.subtree.handler({ref: 'Page', depth: 2}, {})

    expect(runCommand.mock.calls.map(call => call[0])).toEqual([
      {type: 'view-block', ref: 'today'},
      {type: 'view-outline', ref: 'Page', depth: 2},
    ])
    expect(block.content).toEqual([{type: 'text', text: '- hello  ^abc'}])
    expect(outline.content).toEqual([{type: 'text', text: '- hello  ^abc'}])
  })

  it('sql_query sends maxRows and refuses writes without calling the bridge', async () => {
    const runCommand = vi.fn<BridgeClient['runCommand']>(async () => ({rows: []}))
    const server = createGraphMcpServer({
      client: clientFrom(runCommand),
      serverOptions: {capabilities: {tools: {}}},
    })
    const tools = (server as unknown as RegisteredToolHarness)._registeredTools

    await tools.sql_query.handler({sql: 'select 1'}, {})
    expect(runCommand).toHaveBeenCalledWith(expect.objectContaining({type: 'sql', mode: 'all', maxRows: 200}))

    runCommand.mockClear()
    await expect(tools.sql_query.handler({sql: 'delete from blocks'}, {})).rejects.toThrow(/read-only/)
    expect(runCommand).not.toHaveBeenCalled()
  })

  it('serves the base instructions, with a caller\'s text appended', () => {
    const client = clientFrom(vi.fn<BridgeClient['runCommand']>())
    const plain = createGraphMcpServer({client, serverOptions: {capabilities: {tools: {}}}})
    const extended = createGraphMcpServer({
      client,
      serverOptions: {capabilities: {tools: {}}, instructions: 'dispatch rules'},
    })

    expect((plain as unknown as ServerInfoHarness).server._instructions).toBe(KM_MCP_INSTRUCTIONS)
    expect((extended as unknown as ServerInfoHarness).server._instructions)
      .toBe(`${KM_MCP_INSTRUCTIONS}\n\ndispatch rules`)
  })
})
