import {describe, expect, it, vi} from 'vitest'
import type {CallToolResult} from '@modelcontextprotocol/sdk/types.js'
import fs from 'node:fs/promises'
import path from 'node:path'
import {fileURLToPath} from 'node:url'
import type {BridgeClient} from '../src/client'
import type {KnownCommand} from '../src/protocol'
import {createGraphMcpServer, type GraphMcpWriteOperation} from '../src/mcpServer'

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
        case 'append-markdown':
          return {
            target: {id: 'p', shortId: 'p', kind: 'block', created: false, content: 'Parent'},
            blocks: [{id: 'n', shortId: 'n', parentId: 'p', depth: 0, content: 'note'}],
          }
        case 'edit-block':
          return {id: command.id, content: 'edited'}
        case 'create-page':
          return {id: 'page', kind: 'page', created: true}
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
    await tools.append_markdown.handler({target: 'today', markdown: '- note'}, {})
    await tools.edit_block.handler({id: 'b', old: 'a', new: 'b'}, {})
    await tools.create_page.handler({name: 'Inbox'}, {})

    expect(operations).toEqual([
      {type: 'create_block', parentId: 'p', content: 'hi', properties: {x: 1}},
      {type: 'update_block', id: 'b', content: 'edited', properties: undefined, expectedContent: undefined},
      {type: 'move_block', id: 'b', parentId: null, position: {kind: 'last'}},
      {type: 'delete_block', id: 'b'},
      {type: 'restore_block', id: 'b'},
      {type: 'append_markdown', target: 'today', markdown: '- note', position: undefined, shape: undefined},
      {type: 'edit_block', id: 'b', old: 'a', new: 'b'},
      {type: 'create_page', name: 'Inbox', date: undefined},
    ])
    expect(commands.map(command => command.type)).toEqual([
      'create-block',
      'update-block',
      'move-block',
      'delete-block',
      'restore-block',
      'append-markdown',
      'edit-block',
      'create-page',
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
})

describe('recent_changes', () => {
  it('defaults to what changed since this MCP session started', async () => {
    const commands: KnownCommand[] = []
    const before = Date.now()
    const server = createGraphMcpServer({
      client: clientFrom(async command => {
        commands.push(command)
        return {txs: []}
      }),
      serverOptions: {capabilities: {tools: {}}},
    })
    const tools = (server as unknown as RegisteredToolHarness)._registeredTools

    await tools.recent_changes.handler({}, {})
    await tools.recent_changes.handler({since: 0}, {})

    const [sessionDefault, explicit] = commands as Array<{since?: number}>
    expect(sessionDefault.since).toBeGreaterThanOrEqual(before)
    expect(sessionDefault.since).toBeLessThanOrEqual(Date.now())
    expect(explicit.since).toBe(0)
  })
})
