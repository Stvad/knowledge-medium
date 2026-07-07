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

  it('blocks move_block when exact placement would re-key a tied blocked sibling', async () => {
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
          if (command.id === 'moving') {
            return {
              id: 'moving',
              content: 'clean source',
              properties: {},
              parentId: 'old-parent',
              workspaceId: 'ws-1',
            }
          }
          if (command.id === 'blocked-page') {
            return {
              id: 'blocked-page',
              content: 'claude',
              properties: {},
            }
          }
          return null
        case 'sql':
          if (command.sql.includes('SELECT workspace_id')) {
            return [{workspace_id: 'ws-1'}]
          }
          return [
            {id: 'anchor', content: 'anchor', properties_json: '{}', order_key: 'a0'},
            {id: 'blocked-sibling', content: 'mentions [[claude]]', properties_json: '{}', order_key: 'a0'},
            {id: 'later', content: 'later', properties_json: '{}', order_key: 'a1'},
          ]
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
      id: 'moving',
      parentId: 'parent',
      position: {kind: 'after', siblingId: 'anchor'},
    }, {})).rejects.toThrow('references a blocked page')

    expect(commands.map(command => command.type)).toEqual([
      'get-block',
      'page',
      'get-block',
      'sql',
      'sql',
    ])
  })

  it('blocks restore_block when the tombstoned block references a blocked wikilink target', async () => {
    const commands: KnownCommand[] = []
    const client = clientFrom(async command => {
      commands.push(command)
      switch (command.type) {
        case 'sql':
          return [{
            content: 'old mention of ((blocked-page))',
            properties_json: '{}',
          }]
        case 'page':
          return {
            match: {id: 'blocked-page', content: 'claude', types: [], deepLink: ''},
            candidates: [],
          }
        case 'get-block':
          return {
            id: 'blocked-page',
            content: 'claude',
            properties: {},
          }
        case 'restore-block':
          return {id: command.id, content: 'restored'}
        default:
          throw new Error(`Unexpected command: ${command.type}`)
      }
    })

    const server = createGraphMcpServer({
      client,
      blockedWikilinks: ['claude'],
      serverOptions: {capabilities: {tools: {}}},
    })
    const restoreBlock = (server as unknown as RegisteredToolHarness)._registeredTools.restore_block

    await expect(restoreBlock.handler({
      id: 'source-block',
    }, {})).rejects.toThrow('references a blocked page')

    expect(commands.map(command => command.type)).toEqual([
      'sql',
      'page',
      'get-block',
    ])
  })
})
