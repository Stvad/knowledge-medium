import {describe, expect, it, vi} from 'vitest'
import type {CallToolResult} from '@modelcontextprotocol/sdk/types.js'
import type {BridgeClient} from '../src/client'
import type {KnownCommand} from '../src/protocol'
import {createGraphMcpServer, type GraphMcpWriteOperation} from '../src/mcpServer'

interface RegisteredToolHarness {
  _registeredTools: Record<string, {
    handler: (
      args: Record<string, unknown>,
      extra: Record<string, never>,
    ) => CallToolResult | Promise<CallToolResult>
  }>
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
})
