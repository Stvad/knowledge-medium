/**
 * The eval fixture in a node test repo, reachable through the real km MCP
 * server with no browser: `createGraphMcpServer` runs against a BridgeClient
 * that hands each wire command to the tab's own `executeCommand`, validated
 * and serialized the way bridge.ts does it.
 */
import { provideRuntimeGlobals } from './nodeShims'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { knownAgentCommandSchema, type KnownCommand } from '@knowledge-medium/agent-cli/protocol'
import type { BridgeClient } from '../../packages/agent-cli/src/client'
import { createGraphMcpServer } from '../../packages/agent-cli/src/mcpServer'
import { kernelValuePresetsExtension } from '@/components/propertyEditors/kernelValuePresets'
import { getOrCreatePropertiesPage } from '@/data/propertiesPage'
import type { TestDb } from '@/data/test/createTestDb'
import { createTestRepo } from '@/data/test/createTestRepo'
import { staticDataExtensions } from '@/extensions/staticDataExtensions'
import { resolveFacetRuntimeSync } from '@/facets/facet'
import { createAgentRuntimeContext, executeCommand } from '@/plugins/agent-runtime/commands'
import type { AgentRuntimeContext } from '@/plugins/agent-runtime/protocol'
import { serializeError, serializeValue } from '@/plugins/agent-runtime/serialization'
import { importRoam } from '@/plugins/roam-import/import'
import { buildFixture } from './fixture'

/** UUID-shaped so ids and deep links have the byte length a live
 *  workspace gives them; output sizes here should match the dev tab's. */
export const TEST_WORKSPACE_ID = '0e7a1000-0000-4000-8000-000000000001'
const TEST_USER = {id: 'km-eval', name: 'km-eval'}

export const createInProcessBridgeClient = (context: AgentRuntimeContext): BridgeClient => ({
  bridgeUrl: 'in-process://agent-eval',
  runCommand: async command => {
    const parsed = knownAgentCommandSchema.parse(command)
    let value: unknown
    try {
      value = serializeValue(await executeCommand(parsed, context))
    } catch (error) {
      throw new Error(serializeError(error).message, {cause: error})
    }
    return JSON.parse(JSON.stringify(value)) as unknown
  },
  nextEvents: async () => ({events: [], nextSeq: 0}),
  whoami: async () => ({
    clientId: 'in-process',
    audience: {userId: TEST_USER.id, workspaceId: TEST_WORKSPACE_ID, label: 'agent-eval'},
    scope: 'read-write',
    connected: true,
    clientLastSeen: null,
  }),
  health: async () => {},
  resolveToken: async () => 'in-process',
})

export interface FixtureTestGraph {
  /** Calls a km MCP tool by name and returns its text output. */
  callTool: (name: string, args: Record<string, unknown>) => Promise<string>
  /** A raw wire command, for test setup that must not depend on a tool's
   *  rendered output (which the read-path work reshapes). */
  command: (command: KnownCommand) => Promise<unknown>
  close: () => Promise<void>
}

export const seedFixtureTestGraph = async (db: TestDb['db']): Promise<FixtureTestGraph> => {
  // Wall-clock `now`, as in the app, so task checks can compare block
  // timestamps with a start time the way the live runner does.
  const {repo} = createTestRepo({db, user: TEST_USER, startSyncObserver: true, now: Date.now})
  repo.setActiveWorkspaceId(TEST_WORKSPACE_ID)
  const runtime = resolveFacetRuntimeSync(
    [kernelValuePresetsExtension, ...staticDataExtensions],
    {repo, workspaceId: TEST_WORKSPACE_ID, safeMode: false},
  )
  repo.setFacetRuntime(runtime)
  await getOrCreatePropertiesPage(repo, TEST_WORKSPACE_ID)
  await importRoam(buildFixture().pages, repo, {workspaceId: TEST_WORKSPACE_ID, currentUserId: TEST_USER.id})

  provideRuntimeGlobals()
  const context = createAgentRuntimeContext({repo, runtime, safeMode: false})
  const bridge = createInProcessBridgeClient(context)
  const server = createGraphMcpServer({client: bridge})
  const client = new Client({name: 'agent-eval', version: '0'})
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)])

  const callTool = async (name: string, args: Record<string, unknown>): Promise<string> => {
    const result = await client.callTool({name, arguments: args})
    const content = result.content as Array<{type: string, text?: string}>
    const text = content.map(part => part.text ?? '').join('')
    if (result.isError) throw new Error(`${name} failed: ${text}`)
    return text
  }

  return {
    callTool,
    command: command => bridge.runCommand(command),
    close: async () => {
      await client.close()
      await server.close()
      repo.stopSyncObserver()
    },
  }
}
