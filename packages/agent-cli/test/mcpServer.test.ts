import {describe, expect, it} from 'vitest'
import type {CallToolResult} from '@modelcontextprotocol/sdk/types.js'
import type {BridgeClient} from '../src/client'
import type {KnownCommand} from '../src/protocol'
import {createGraphMcpServer} from '../src/mcpServer'

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
  it('blocks move_block when the existing block references a blocked wikilink target', async () => {
    const commands: KnownCommand[] = []
    const client = clientFrom(async command => {
      commands.push(command)
      switch (command.type) {
        case 'page':
          return {
            match: {id: 'blocked-page', content: 'claude', types: [], deepLink: ''},
            candidates: [],
          }
        case 'get-block':
          if (command.id === 'source-block') {
            return {
              id: 'source-block',
              content: 'old mention of [[claude]]',
              properties: {},
              parentId: 'old-parent',
            }
          }
          if (command.id === 'blocked-page') {
            return {
              id: 'blocked-page',
              content: 'claude',
              properties: {alias: ['cc']},
            }
          }
          return null
        case 'move-block':
          return {id: command.id, parentId: command.parentId}
        default:
          throw new Error(`Unexpected command: ${command.type}`)
      }
    })

    const server = createGraphMcpServer({
      client,
      blockedWikilinks: ['claude'],
      serverOptions: {capabilities: {tools: {}}},
    })
    const moveBlock = (server as unknown as RegisteredToolHarness)._registeredTools.move_block

    await expect(moveBlock.handler({
      id: 'source-block',
      parentId: 'new-parent',
      position: {kind: 'last'},
    }, {})).rejects.toThrow('references a blocked page')

    expect(commands.map(command => command.type)).toEqual([
      'get-block',
      'page',
      'get-block',
    ])
  })
})
