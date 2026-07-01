import {describe, expect, it, vi} from 'vitest'
import {createEngine, type EngineDeps} from '../src/engine'
import {parseConfig, PROPS} from '../src/config'
import type {BlockData, Graph} from '../src/graph'
import type {ClaudeRunResult} from '../src/runner'
import type {StateStore} from '../src/state'

const NOW = 1_800_000_000_000

interface FakeGraphSeed {
  pageId?: string
  backlinks?: Array<{id: string, deepLink?: string}>
  blocks?: Record<string, Partial<BlockData>>
}

/** Minimal in-memory graph double tracking writes. */
const fakeGraph = (seed: FakeGraphSeed = {}) => {
  const blocks = new Map<string, BlockData>(
    Object.entries(seed.blocks ?? {}).map(([id, data]) => [id, {id, properties: {}, ...data}]),
  )
  const replies: Array<{parentId: string, content: string}> = []
  const propWrites: Array<{id: string, status: string}> = []

  const graph: Graph = {
    client: null as never,
    resolvePageId: vi.fn(async () => seed.pageId ?? 'page-claude'),
    backlinkSources: vi.fn(async () =>
      (seed.backlinks ?? []).map(({id, deepLink}) => ({
        id, content: blocks.get(id)?.content ?? '', types: [], deepLink: deepLink ?? `link:${id}`, sourceFields: ['content'],
      }))),
    getBlock: async id => blocks.get(id) ?? null,
    ancestors: async id => {
      const chain: BlockData[] = []
      let current = blocks.get(id)
      while (current?.parentId) {
        const parent = blocks.get(current.parentId)
        if (!parent) break
        chain.push(parent)
        current = parent
      }
      return chain
    },
    getSubtree: async rootId => [
      {id: rootId, parentId: null, content: blocks.get(rootId)?.content ?? '', depth: 0} as BlockData,
    ],
    setTaskProps: async (id, args) => {
      const block = blocks.get(id) ?? {id, properties: {}}
      block.properties = {
        ...block.properties,
        [PROPS.status]: args.status,
        [PROPS.updatedAt]: args.nowMs,
        ...(args.watcher !== undefined ? {[PROPS.watcher]: args.watcher} : {}),
        ...(args.session ? {[PROPS.session]: args.session} : {}),
        ...(args.error !== undefined ? {[PROPS.error]: args.error ?? ''} : {}),
      }
      blocks.set(id, block)
      propWrites.push({id, status: args.status})
    },
    createReply: async (parentId, content) => {
      replies.push({parentId, content})
      const reply: BlockData = {id: `reply-${replies.length}`, parentId, content, properties: {[PROPS.reply]: true}}
      blocks.set(reply.id, reply)
      return reply
    },
    sqlAll: vi.fn(async () => []),
    blockProps: async ids => new Map(
      ids.flatMap(id => {
        const block = blocks.get(id)
        return block ? [[id, block.properties ?? {}] as const] : []
      }),
    ),
  }

  return {graph, blocks, replies, propWrites}
}

const memoryState = (): StateStore & {cursors: Map<string, string[]>} => {
  const cursors = new Map<string, string[]>()
  return {
    cursors,
    getCursor: async name => cursors.get(name) ?? null,
    setCursor: async (name, ids) => { cursors.set(name, ids) },
  }
}

const okRun = (overrides: Partial<ClaudeRunResult> = {}): ClaudeRunResult => ({
  ok: true, resultText: 'Reply text', sessionId: 'sess-1', exitCode: 0, timedOut: false, stderr: '', raw: {},
  ...overrides,
})

const mentionConfig = (overrides: object = {}) => parseConfig({
  watchers: [{kind: 'backlinks', name: 'mentions', target: 'claude'}],
  ...overrides,
})

const engineWith = (deps: Partial<EngineDeps> & Pick<EngineDeps, 'graph'>) =>
  createEngine({
    config: mentionConfig(),
    state: memoryState(),
    runTask: vi.fn(async () => okRun()),
    deliverToChannel: vi.fn(async () => {}),
    mcpConfigPath: '/tmp/mcp.json',
    log: () => {},
    now: () => NOW,
    ...deps,
  })

describe('mention lifecycle', () => {
  it('claims, runs, replies, and marks done with the session id', async () => {
    const {graph, blocks, replies, propWrites} = fakeGraph({
      backlinks: [{id: 'b-1'}],
      blocks: {'b-1': {content: '[[claude]] summarize inbox'}},
    })
    const runTask = vi.fn(async () => okRun())
    const engine = engineWith({graph, runTask})

    await engine.tick()
    await engine.drain()

    expect(propWrites.map(write => write.status)).toEqual(['running', 'done'])
    expect(replies).toEqual([{parentId: 'b-1', content: 'Reply text'}])
    expect(blocks.get('b-1')?.properties?.[PROPS.session]).toBe('sess-1')

    const prompt = (runTask.mock.calls[0][0] as {prompt: string}).prompt
    expect(prompt).toContain('[[claude]] summarize inbox')
  })

  it('is idempotent: a processed mention does not re-run on later ticks', async () => {
    const {graph, replies} = fakeGraph({
      backlinks: [{id: 'b-1'}],
      blocks: {'b-1': {content: '[[claude]] hi'}},
    })
    const runTask = vi.fn(async () => okRun())
    const engine = engineWith({graph, runTask})

    await engine.tick()
    await engine.drain()
    await engine.tick()
    await engine.drain()

    expect(runTask).toHaveBeenCalledTimes(1)
    expect(replies).toHaveLength(1)
  })

  it('replies with a failure note and marks error on a failed run', async () => {
    const {graph, blocks, replies} = fakeGraph({
      backlinks: [{id: 'b-1'}],
      blocks: {'b-1': {content: '[[claude]] break'}},
    })
    const engine = engineWith({
      graph,
      runTask: vi.fn(async () => okRun({ok: false, exitCode: 1, stderr: 'credit exhausted', resultText: ''})),
    })

    await engine.tick()
    await engine.drain()

    expect(blocks.get('b-1')?.properties?.[PROPS.status]).toBe('error')
    expect(replies[0].content).toContain('run failed')
    expect(replies[0].content).toContain('credit exhausted')
  })

  it('resumes the nearest ancestor session for follow-up mentions', async () => {
    const {graph} = fakeGraph({
      backlinks: [{id: 'b-child'}],
      blocks: {
        'b-root': {content: '[[claude]] original', properties: {[PROPS.status]: 'done', [PROPS.session]: 'sess-root'}},
        'b-child': {content: '[[claude]] follow up', parentId: 'b-root'},
      },
    })
    const runTask = vi.fn(async () => okRun())
    const engine = engineWith({graph, runTask})

    await engine.tick()
    await engine.drain()

    expect((runTask.mock.calls[0][0] as {resumeSessionId?: string}).resumeSessionId).toBe('sess-root')
  })

  it('respects maxConcurrent across a tick', async () => {
    const {graph} = fakeGraph({
      backlinks: [{id: 'b-1'}, {id: 'b-2'}, {id: 'b-3'}],
      blocks: {
        'b-1': {content: '[[claude]] 1'},
        'b-2': {content: '[[claude]] 2'},
        'b-3': {content: '[[claude]] 3'},
      },
    })
    let live = 0
    let peak = 0
    const runTask = vi.fn(async () => {
      live += 1
      peak = Math.max(peak, live)
      await new Promise(resolve => setTimeout(resolve, 20))
      live -= 1
      return okRun()
    })
    const engine = engineWith({
      graph,
      runTask,
      config: mentionConfig({maxConcurrent: 2}),
    })

    await engine.tick()
    await engine.drain()

    expect(peak).toBeLessThanOrEqual(2)
    // Third mention picked up by a later tick, not lost.
    await engine.tick()
    await engine.drain()
    expect(runTask).toHaveBeenCalledTimes(3)
  })

  it('passes the km MCP allowlist plus watcher extras to the run', async () => {
    const {graph} = fakeGraph({
      backlinks: [{id: 'b-1'}],
      blocks: {'b-1': {content: '[[claude]] with tools'}},
    })
    const runTask = vi.fn(async () => okRun())
    const engine = engineWith({
      graph,
      runTask,
      config: parseConfig({
        watchers: [{kind: 'backlinks', name: 'mentions', target: 'claude', allowedTools: ['Bash(git:*)']}],
      }),
    })

    await engine.tick()
    await engine.drain()

    const tools = (runTask.mock.calls[0][0] as {allowedTools: string[]}).allowedTools
    expect(tools).toContain('mcp__km__get_block')
    expect(tools).toContain('Bash(git:*)')
  })
})

describe('channel delivery (experimental)', () => {
  const channelConfig = () => parseConfig({
    watchers: [{kind: 'backlinks', name: 'mentions', target: 'claude', delivery: 'channel'}],
  })

  it('claims and delivers to the channel instead of spawning; lifecycle left open', async () => {
    const {graph, blocks, replies} = fakeGraph({
      backlinks: [{id: 'b-1'}],
      blocks: {'b-1': {content: '[[claude]] ambient task'}},
    })
    const runTask = vi.fn(async () => okRun())
    const deliverToChannel = vi.fn(async () => {})
    const engine = engineWith({graph, runTask, deliverToChannel, config: channelConfig()})

    await engine.tick()
    await engine.drain()

    expect(runTask).not.toHaveBeenCalled()
    expect(deliverToChannel).toHaveBeenCalledTimes(1)
    const event = deliverToChannel.mock.calls[0][0] as {content: string, meta: Record<string, string>}
    expect(event.meta).toEqual({watcher: 'mentions', block_id: 'b-1'})
    expect(event.content).toContain('close the task out yourself')
    // Daemon only claims; the ambient session finishes the lifecycle.
    expect(blocks.get('b-1')?.properties?.[PROPS.status]).toBe('running')
    expect(replies).toHaveLength(0)
  })

  it('marks the task error when the channel listener is unreachable', async () => {
    const {graph, blocks} = fakeGraph({
      backlinks: [{id: 'b-1'}],
      blocks: {'b-1': {content: '[[claude]] ambient task'}},
    })
    const engine = engineWith({
      graph,
      deliverToChannel: vi.fn(async () => { throw new Error('connection refused') }),
      config: channelConfig(),
    })

    await engine.tick()
    await engine.drain()

    expect(blocks.get('b-1')?.properties?.[PROPS.status]).toBe('error')
  })
})

describe('query watcher lifecycle', () => {
  const queryConfig = () => parseConfig({
    watchers: [{kind: 'query', name: 'inbox', sql: 'SELECT id FROM blocks'}],
  })

  it('baselines on first tick without firing, then fires only for new ids', async () => {
    const {graph} = fakeGraph()
    const rows = [[{id: 'a'}], [{id: 'a'}, {id: 'b'}]]
    let call = 0
    graph.sqlAll = vi.fn(async () => rows[Math.min(call++, rows.length - 1)])
    const state = memoryState()
    const runTask = vi.fn(async () => okRun())
    const engine = engineWith({graph, runTask, state, config: queryConfig()})

    await engine.tick()   // baseline
    await engine.drain()
    expect(runTask).not.toHaveBeenCalled()

    await engine.tick()   // 'b' is new
    await engine.drain()
    expect(runTask).toHaveBeenCalledTimes(1)
    const prompt = (runTask.mock.calls[0][0] as {prompt: string}).prompt
    expect(prompt).toContain('"id": "b"')
    expect(state.cursors.get('inbox')).toEqual(['a', 'b'])
  })

  it('advances the cursor even when the run fails (no re-bill loop)', async () => {
    const {graph} = fakeGraph()
    graph.sqlAll = vi.fn(async () => [{id: 'a'}])
    const state = memoryState()
    state.cursors.set('inbox', [])
    const runTask = vi.fn(async () => okRun({ok: false, exitCode: 1}))
    const engine = engineWith({graph, runTask, state, config: queryConfig()})

    await engine.tick()
    await engine.drain()
    await engine.tick()
    await engine.drain()

    expect(runTask).toHaveBeenCalledTimes(1)
  })
})
