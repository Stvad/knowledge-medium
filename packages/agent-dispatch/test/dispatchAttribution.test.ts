// @vitest-environment happy-dom
/* The daemon's two graph handles against the app itself: the real engine and
 * graph modules, over a bridge client that hands each wire command to the
 * runtime's own `executeCommand`, with the contributors processor installed. */
import {afterAll, beforeAll, beforeEach, describe, expect, it, vi} from 'vitest'
import {withContributorId, type BridgeClient} from '@knowledge-medium/agent-cli/client'
import {knownAgentCommandSchema} from '@knowledge-medium/agent-cli/protocol'
import {ChangeScope} from '@/data/api'
import {PAGE_TYPE} from '@/data/blockTypes'
import {aliasesProp, typesProp} from '@/data/properties'
import type {Repo} from '@/data/repo'
import {createTestDb, resetTestDb, type TestDb} from '@/data/test/createTestDb'
import {createTestRepo} from '@/data/test/createTestRepo'
import {staticDataExtensions} from '@/extensions/staticDataExtensions'
import {resolveFacetRuntimeSync} from '@/facets/facet'
import {commandResult} from '@/plugins/agent-runtime/bridgeLoop'
import {createAgentRuntimeContext, executeCommand} from '@/plugins/agent-runtime/commands'
import type {AgentRuntimeContext} from '@/plugins/agent-runtime/protocol'
import {attributionCreatorsProp, attributionEditorsProp} from '@/plugins/contributors/schema'
import {parseConfig, PROPS} from '../src/config'
import {createEngine} from '../src/engine'
import {createGraph, createReplyWriter} from '../src/graph'
import type {AgentRunOptions, AgentRunResult} from '../src/runner'
import type {StateStore} from '../src/state'

const WS = 'ws'
const CLAUDE = '3f2a9c1d-0000-4000-8000-0000000000c1'
const MENTION = '3f2a9c1d-0000-4000-8000-0000000000d1'
const opts = {scope: ChangeScope.BlockDefault}

let db: TestDb
let repo: Repo
let context: AgentRuntimeContext
let agentId: string
beforeAll(async () => { db = await createTestDb() })
afterAll(async () => { await db.cleanup() })

const inProcessClient = (): BridgeClient => ({
  bridgeUrl: 'in-process://dispatch-attribution',
  runCommand: async command => {
    const result = await commandResult(() => executeCommand(knownAgentCommandSchema.parse(command), context))
    if (!result.ok) throw new Error(result.error.message)
    return JSON.parse(JSON.stringify(result.value)) as unknown
  },
  nextEvents: async () => ({events: [], nextSeq: 0}),
  whoami: async () => {
    throw new Error('not used')
  },
  health: async () => {},
  resolveToken: async () => 'in-process',
})

beforeEach(async () => {
  await resetTestDb(db.db)
  repo = createTestRepo({db: db.db, user: {id: 'vlad', name: 'Vlad'}}).repo
  const runtime = resolveFacetRuntimeSync(staticDataExtensions, {repo, workspaceId: WS, safeMode: false})
  repo.setFacetRuntime(runtime)
  repo.setActiveWorkspaceId(WS)
  context = createAgentRuntimeContext({repo, runtime, safeMode: false})
  // The person's note, written in the tab: a human-only write records no
  // attribution.
  await repo.tx(async tx => {
    await tx.create({id: CLAUDE, workspaceId: WS, parentId: null, orderKey: 'a0', content: 'claude',
      properties: {[typesProp.name]: [PAGE_TYPE], [aliasesProp.name]: ['claude']}})
    await tx.create({id: 'page', workspaceId: WS, parentId: null, orderKey: 'a1', content: 'Notes',
      properties: {[typesProp.name]: [PAGE_TYPE]}})
    await tx.create({id: MENTION, workspaceId: WS, parentId: 'page', orderKey: 'a0', content: '[[claude]] summarize this'})
  }, opts)
  await repo.awaitProcessors()
  const agent = await inProcessClient().runCommand({type: 'create-contributor', name: 'Claude agent'}) as {id: string}
  agentId = agent.id
})

const memoryState = (): StateStore => ({
  getCursor: async () => null,
  setCursor: async () => {},
  getBaseline: async () => 0,
  setBaseline: async () => {},
  getLaunchTimes: async () => [],
  setLaunchTimes: async () => {},
})

/** The daemon's wiring: one client carrying the agent's contributor. */
const engineFor = (runTask: (options: AgentRunOptions) => Promise<AgentRunResult>) => {
  const client = withContributorId(inProcessClient(), agentId)
  return createEngine({
    config: parseConfig({
      workspaceId: WS,
      watchers: [{kind: 'backlinks', name: 'mentions', target: 'claude', quietMs: 0, streamReply: true}],
    }),
    graph: createGraph(client),
    replies: createReplyWriter(client),
    state: memoryState(),
    runTask,
    deliverToChannel: async () => {},
    mcpConfigPath: null,
    log: () => {},
    delay: async () => {},
  })
}

const attributionOf = async (id: string) => {
  const row = await repo.load(id)
  return {
    creators: row?.properties[attributionCreatorsProp.name] ?? [],
    editors: row?.properties[attributionEditorsProp.name] ?? [],
  }
}

/** A person's property write to the mention, as the Stop chip makes it. */
const writeInTab = (properties: Record<string, unknown>) => repo.tx(async tx => {
  const row = await tx.get(MENTION)
  await tx.update(MENTION, {properties: {...row!.properties, ...properties}})
}, opts)

const replyIds = async (): Promise<string[]> => {
  const rows = await db.db.getAll<{id: string}>(
    `SELECT id FROM blocks WHERE parent_id = ? AND deleted = 0 AND json_extract(properties_json, '$."${PROPS.reply}"') = 1`,
    [MENTION],
  )
  return rows.map(row => row.id)
}

const result = (overrides: Partial<AgentRunResult>): AgentRunResult => ({
  ok: true, resultText: '', sessionId: 'sess-1', exitCode: 0, timedOut: false, stderr: '', raw: {}, ...overrides,
})

describe('dispatch attribution', () => {
  it('leaves the mentioning block\'s authors untouched through a whole run, and attributes the reply', async () => {
    expect(await attributionOf(MENTION)).toEqual({creators: [], editors: []})
    const engine = engineFor(async options => {
      options.onEvent?.({kind: 'session', sessionId: 'sess-1'})
      options.onEvent?.({kind: 'activity', label: 'Reading the page'})
      options.onEvent?.({kind: 'text', text: 'Half an answer'})
      return result({resultText: 'The summary.'})
    })

    await engine.tick()
    await engine.drain()

    const mention = await repo.load(MENTION)
    // The run went through claim, activity, session and completion.
    expect(mention?.properties).toMatchObject({[PROPS.status]: 'done', [PROPS.session]: 'sess-1', [PROPS.activity]: ''})
    expect(await attributionOf(MENTION)).toEqual({creators: [], editors: []})
    const replies = await replyIds()
    expect(replies).toHaveLength(1)
    // Streaming edits the reply after creating it, so the agent is also its editor.
    expect((await attributionOf(replies[0])).creators).toEqual([agentId])
  })

  it('leaves them untouched through a cancelled run', async () => {
    let started!: () => void
    const running = new Promise<void>(resolve => { started = resolve })
    const engine = engineFor(options => new Promise(resolve => {
      started()
      options.signal?.addEventListener('abort', () => resolve(result({ok: false, exitCode: null})))
    }))

    await engine.tick()
    await running
    // The Stop chip's write, made in the tab.
    await writeInTab({[PROPS.cancel]: 'requested'})
    await engine.tick()
    await engine.drain()

    const mention = await repo.load(MENTION)
    expect(mention?.properties).toMatchObject({[PROPS.status]: 'error', [PROPS.error]: 'cancelled', [PROPS.cancel]: ''})
    expect(await attributionOf(MENTION)).toEqual({creators: [], editors: []})
  })

  it('leaves them untouched when clearing a cancel no run owns', async () => {
    await writeInTab({[PROPS.status]: 'running', [PROPS.cancel]: 'requested'})
    const runTask = vi.fn(async () => result({}))

    await engineFor(runTask).tick()

    expect((await repo.load(MENTION))?.properties[PROPS.cancel]).toBe('')
    expect(runTask).not.toHaveBeenCalled()
    expect(await attributionOf(MENTION)).toEqual({creators: [], editors: []})
  })
})
