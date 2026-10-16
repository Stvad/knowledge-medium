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
      if (command.type === 'resolve-block-id') return {id: `full-${command.ref}`}
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
    await tools.move_block.handler({id: 'b', parentId: '^p', position: {kind: 'after', siblingId: 's'}}, {})
    await tools.delete_block.handler({id: 'b'}, {})
    await tools.restore_block.handler({id: 'b'}, {})
    await tools.append_markdown.handler({
      target: 'today', markdown: '- note', position: {kind: 'before', siblingId: 's'},
    }, {})
    await tools.edit_block.handler({id: 'b', old: 'a', new: 'b'}, {})
    await tools.create_page.handler({name: 'Inbox'}, {})

    expect(operations).toEqual([
      {type: 'create_block', parentId: 'p', content: 'hi', properties: {x: 1}},
      {type: 'update_block', id: 'full-b', content: 'edited', properties: undefined, expectedContent: undefined},
      {type: 'move_block', id: 'full-b', parentId: 'full-^p', position: {kind: 'after', siblingId: 'full-s'}},
      {type: 'delete_block', id: 'full-b'},
      {type: 'restore_block', id: 'full-b'},
      {
        type: 'append_markdown', target: 'today', markdown: '- note',
        position: {kind: 'before', siblingId: 'full-s'}, shape: undefined,
      },
      {type: 'edit_block', id: 'full-b', old: 'a', new: 'b'},
      {type: 'create_page', name: 'Inbox', date: undefined},
    ])
    // The write acts on the id the guard checked.
    expect(commands.filter(command => 'id' in command).map(command => (command as {id?: unknown}).id))
      .toEqual(['full-b', 'full-b', 'full-b', 'full-b', 'full-b'])
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
    const runCommand = vi.fn<BridgeClient['runCommand']>(async command =>
      command.type === 'resolve-block-id' ? {id: command.ref} : undefined)
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
    // Only the id lookup the guard needed — no write.
    expect(runCommand.mock.calls.map(([command]) => command.type)).toEqual(['resolve-block-id'])
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

  // A token reaches every workspace of its user; these reads resolve against
  // one workspace, so the tool takes it as a parameter (default: the open one).
  it('forwards a workspaceId on the workspace-scoped reads', async () => {
    const commands: KnownCommand[] = []
    const client = clientFrom(async command => {
      commands.push(command)
      return {}
    })
    const server = createGraphMcpServer({client, serverOptions: {capabilities: {tools: {}}}})
    const tools = (server as unknown as RegisteredToolHarness)._registeredTools

    await tools.page.handler({name: 'Inbox', workspaceId: 'ws-2'}, {})
    await tools.daily_note.handler({date: 'today', workspaceId: 'ws-2'}, {})
    await tools.search.handler({query: 'x', workspaceId: 'ws-2'}, {})
    await tools.search.handler({query: 'x'}, {})

    expect(commands.map(command => (command as {workspaceId?: string}).workspaceId))
      .toEqual(['ws-2', 'ws-2', 'ws-2', undefined])
  })
})
