/**
 * The eval fixture in a node repo with the app's own data extensions, which
 * is the graph every eval task runs on: the runner's hosts serve it to the
 * agent bridge (host.ts), and the fixture test drives it in-process through
 * the real km MCP server, over a BridgeClient that hands each wire command to
 * the runtime's own `executeCommand`, validated and serialized the way the
 * bridge loop does it.
 */
import { provideRuntimeGlobals } from './nodeShims'
import { knownAgentCommandSchema, type KnownCommand } from '@knowledge-medium/agent-cli/protocol'
import type { BridgeClient } from '../../packages/agent-cli/src/client'
import { kernelValuePresetsExtension } from '@/components/propertyEditors/kernelValuePresets'
import { getOrCreatePropertiesPage } from '@/data/propertiesPage'
import type { TestDb } from '@/data/test/createTestDb'
import { createTestRepo } from '@/data/test/createTestRepo'
import { staticDataExtensions } from '@/extensions/staticDataExtensions'
import { resolveFacetRuntimeSync } from '@/facets/facet'
import { createAgentRuntimeContext, executeCommand } from '@/plugins/agent-runtime/commands'
import type { AgentRuntimeContext } from '@/plugins/agent-runtime/protocol'
import { serializeError, serializeValue } from '@/plugins/agent-runtime/serialization'
import { getOrCreateDailyNote, todayIso } from '@/plugins/daily-notes'
import { importRoam } from '@/plugins/roam-import/import'
import { buildFixture } from './fixture'
import { connectMcpClient } from './mcpClient'

/** UUID-shaped so ids and deep links have the byte length a live
 *  workspace gives them. */
export const TEST_WORKSPACE_ID = '0e7a1000-0000-4000-8000-000000000001'
export const TEST_USER = {id: 'km-eval', name: 'km-eval'}

export interface FixtureRuntime {
  context: AgentRuntimeContext
  close: () => void
}

/** The app's runtime over `db`. With `seed`, imports the fixture first and
 *  sets up what every task starts from (today's daily note, which a write
 *  task appends to), and returns once the processors those writes started
 *  have landed; without it, `db` is a copy of a seeded one. */
export const openFixtureRuntime = async (db: TestDb['db'], {seed}: {seed: boolean}): Promise<FixtureRuntime> => {
  // The app's generators rather than the test defaults: wall-clock `now`, so
  // task checks can compare block timestamps with a task's start time; and
  // ids and tx seqs that a Repo opened on a copy cannot mint twice.
  let txSeq = Date.now()
  const {repo} = createTestRepo({
    db,
    user: TEST_USER,
    startSyncObserver: true,
    now: Date.now,
    newId: () => crypto.randomUUID(),
    newTxSeq: () => ++txSeq,
    blockIdPolicy: 'canonical',
  })
  repo.setActiveWorkspaceId(TEST_WORKSPACE_ID)
  const runtime = resolveFacetRuntimeSync(
    [kernelValuePresetsExtension, ...staticDataExtensions],
    {repo, workspaceId: TEST_WORKSPACE_ID, safeMode: false},
  )
  repo.setFacetRuntime(runtime)
  await getOrCreatePropertiesPage(repo, TEST_WORKSPACE_ID)
  if (seed) {
    await importRoam(buildFixture().pages, repo, {workspaceId: TEST_WORKSPACE_ID, currentUserId: TEST_USER.id})
    await getOrCreateDailyNote(repo, TEST_WORKSPACE_ID, todayIso())
    await repo.awaitDeferredWork()
  }
  provideRuntimeGlobals()
  return {
    context: createAgentRuntimeContext({repo, runtime, safeMode: false}),
    close: () => repo.stopSyncObserver(),
  }
}

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

export const openFixtureTestGraph = async (db: TestDb['db'], options: {seed: boolean}): Promise<FixtureTestGraph> => {
  const runtime = await openFixtureRuntime(db, options)
  const bridge = createInProcessBridgeClient(runtime.context)
  const mcp = await connectMcpClient(bridge)
  return {
    callTool: mcp.callTool,
    command: command => bridge.runCommand(command),
    close: async () => {
      await mcp.close()
      runtime.close()
    },
  }
}
