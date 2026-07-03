import {describe, expect, it, vi} from 'vitest'
import {createEngine, type EngineDeps} from '../src/engine'
import {parseConfig, PROPS} from '../src/config'
import type {BlockData, Graph} from '../src/graph'
import type {ClaudeRunResult} from '../src/runner'
import type {StateStore} from '../src/state'
import {MAX_ATTEMPTS, MAX_CURSOR_IDS} from '../src/watchers'

const NOW = 1_800_000_000_000

interface FakeGraphSeed {
  pageId?: string
  backlinks?: Array<{id: string, deepLink?: string}>
  blocks?: Record<string, Partial<BlockData>>
}

/** Minimal in-memory graph double tracking writes. */
const fakeGraph = (seed: FakeGraphSeed = {}) => {
  const blocks = new Map<string, BlockData>(
    // editedAtMs defaults to NOW: most tests exercise the post-baseline
    // lifecycle, where a candidate block was just edited.
    Object.entries(seed.blocks ?? {}).map(([id, data]) => [id, {id, properties: {}, editedAtMs: NOW, ...data}]),
  )
  const replies: Array<{parentId: string, content: string}> = []
  const propWrites: Array<{id: string, status: string}> = []

  const graph: Graph = {
    resolvePageId: vi.fn(async () => seed.pageId ?? 'page-claude'),
    targetGuardSet: vi.fn(async () => ({id: seed.pageId ?? 'page-claude', aliases: ['claude']})),
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
      {id: rootId, parentId: null, content: blocks.get(rootId)?.content ?? ''} as BlockData,
    ],
    setTaskProps: async (id, args) => {
      const target = blocks.get(id) ?? {id, properties: {}}
      target.properties = {
        ...target.properties,
        [PROPS.status]: args.status,
        [PROPS.updatedAt]: args.nowMs,
        ...(args.watcher !== undefined ? {[PROPS.watcher]: args.watcher} : {}),
        ...(args.session ? {[PROPS.session]: args.session} : {}),
        ...(args.attempts !== undefined ? {[PROPS.attempts]: args.attempts} : {}),
        ...(args.error !== undefined ? {[PROPS.error]: args.error ?? ''} : {}),
      }
      blocks.set(id, target)
      propWrites.push({id, status: args.status})
    },
    createReply: async (parentId, content) => {
      replies.push({parentId, content})
      const reply: BlockData = {id: `reply-${replies.length}`, parentId, content, properties: {[PROPS.reply]: true}}
      blocks.set(reply.id, reply)
      return reply
    },
    sqlAll: vi.fn(async () => []),
    blockViews: async ids => new Map(
      ids.flatMap(id => {
        const target = blocks.get(id)
        return target ? [[id, {id, properties: target.properties ?? {}, editedAtMs: target.editedAtMs ?? null}] as const] : []
      }),
    ),
  }

  return {graph, blocks, replies, propWrites}
}

const memoryState = (
  seedLaunchTimes: number[] = [],
  opts: {armBaselines?: boolean} = {},
): StateStore & {cursors: Map<string, string[]>, baselines: Map<string, number>, launches: number[]} => {
  const cursors = new Map<string, string[]>()
  const baselines = new Map<string, number>()
  // Armed (epoch-0) baseline by default so most tests exercise the
  // post-baseline lifecycle; {armBaselines: false} tests establishment.
  const armed = opts.armBaselines ?? true
  const store = {
    cursors,
    baselines,
    launches: [...seedLaunchTimes],
    getCursor: async (name: string) => cursors.get(name) ?? null,
    setCursor: async (name: string, ids: string[]) => { cursors.set(name, ids) },
    getBaseline: async (name: string) => baselines.get(name) ?? (armed ? 0 : null),
    setBaseline: async (name: string, ms: number) => { baselines.set(name, ms) },
    getLaunchTimes: async () => [...store.launches],
    setLaunchTimes: async (times: number[]) => { store.launches = times },
  }
  return store
}

const okRun = (overrides: Partial<ClaudeRunResult> = {}): ClaudeRunResult => ({
  ok: true, resultText: 'Reply text', sessionId: 'sess-1', exitCode: 0, timedOut: false, stderr: '', raw: {},
  ...overrides,
})

const mentionConfig = (overrides: object = {}) => parseConfig({
  watchers: [{kind: 'backlinks', name: 'mentions', target: 'claude', quietMs: 0}],
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
    expect(blocks.get('b-1')?.properties?.[PROPS.attempts]).toBe(1)

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

  it('waits for the quiet period before claiming a just-edited mention', async () => {
    const {graph} = fakeGraph({
      backlinks: [{id: 'b-1'}],
      blocks: {'b-1': {content: '[[claude]] half-typed…', editedAtMs: NOW - 2_000}},
    })
    const runTask = vi.fn(async () => okRun())
    const engine = engineWith({
      graph,
      runTask,
      config: parseConfig({watchers: [{kind: 'backlinks', name: 'mentions', target: 'claude', quietMs: 15_000}]}),
    })

    await engine.tick()
    await engine.drain()
    expect(runTask).not.toHaveBeenCalled()
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

  it('leaves a visible reply even when infrastructure fails mid-task', async () => {
    const {graph, blocks, replies} = fakeGraph({
      backlinks: [{id: 'b-1'}],
      blocks: {'b-1': {content: '[[claude]] infra'}},
    })
    graph.getSubtree = vi.fn(async () => { throw new Error('bridge blipped') })
    const engine = engineWith({graph})

    await engine.tick()
    await engine.drain()

    expect(blocks.get('b-1')?.properties?.[PROPS.status]).toBe('error')
    expect(replies[0].content).toContain('infrastructure error')
    expect(replies[0].content).toContain('bridge blipped')
  })

  it('parks a task after MAX_ATTEMPTS with a terminal error write', async () => {
    const {graph, blocks, replies} = fakeGraph({
      backlinks: [{id: 'b-1'}],
      blocks: {'b-1': {
        content: '[[claude]] cursed',
        properties: {
          [PROPS.status]: 'running',
          [PROPS.updatedAt]: NOW - 60 * 60_000,
          [PROPS.attempts]: MAX_ATTEMPTS,
        },
      }},
    })
    const runTask = vi.fn(async () => okRun())
    const engine = engineWith({graph, runTask})

    await engine.tick()
    await engine.drain()

    expect(runTask).not.toHaveBeenCalled()
    expect(blocks.get('b-1')?.properties?.[PROPS.status]).toBe('error')
    expect(replies[0].content).toContain('gave up after')

    // Terminal: later ticks skip it entirely.
    await engine.tick()
    await engine.drain()
    expect(replies).toHaveLength(1)
  })

  it('parks props-FIRST so a failed reply write cannot spam ⚠️ blocks', async () => {
    const {graph, blocks, replies} = fakeGraph({
      backlinks: [{id: 'b-1'}],
      blocks: {'b-1': {
        content: '[[claude]] cursed',
        properties: {[PROPS.status]: 'running', [PROPS.updatedAt]: NOW - 60 * 60_000, [PROPS.attempts]: MAX_ATTEMPTS},
      }},
    })
    // Reply write is broken; the terminal status must still land so the
    // block isn't re-parked (and re-replied) every tick.
    graph.createReply = vi.fn(async () => { throw new Error('reply write failed') })
    const engine = engineWith({graph})

    await engine.tick()
    await engine.drain()
    expect(blocks.get('b-1')?.properties?.[PROPS.status]).toBe('error')

    await engine.tick()
    await engine.drain()
    expect((graph.createReply as ReturnType<typeof vi.fn>).mock.calls.length).toBeLessThanOrEqual(1)
    expect(replies).toHaveLength(0)
  })

  it('does not re-park a task the channel session already closed (fresh re-read)', async () => {
    const {graph, replies} = fakeGraph({
      backlinks: [{id: 'b-1'}],
      blocks: {'b-1': {
        content: '[[claude]] cursed',
        properties: {[PROPS.status]: 'running', [PROPS.updatedAt]: NOW - 60 * 60_000, [PROPS.attempts]: MAX_ATTEMPTS},
      }},
    })
    // Between the tick snapshot and the park, the ambient session marks it done.
    const realGetBlock = graph.getBlock
    graph.getBlock = async id => {
      const block = await realGetBlock(id)
      if (block) block.properties = {...block.properties, [PROPS.status]: 'done'}
      return block
    }
    const engine = engineWith({graph})

    await engine.tick()
    await engine.drain()
    expect(replies).toHaveLength(0)
  })

  it('does not count a resumed-thread placeholder against maxConcurrent', async () => {
    const {graph} = fakeGraph({
      backlinks: [{id: 'b-follow'}, {id: 'b-other'}],
      blocks: {
        'b-root': {content: 'root', properties: {[PROPS.status]: 'done', [PROPS.session]: 'sess-root'}},
        'b-follow': {content: '[[claude]] follow up', parentId: 'b-root'},
        'b-other': {content: '[[claude]] unrelated'},
      },
    })
    let live = 0
    let peak = 0
    const runTask = vi.fn(async () => {
      live += 1; peak = Math.max(peak, live)
      await new Promise(resolve => setTimeout(resolve, 20))
      live -= 1
      return okRun()
    })
    // maxConcurrent 2: the follow-up's session placeholder must NOT eat a
    // second slot and block the unrelated mention.
    const engine = engineWith({graph, runTask, config: mentionConfig({maxConcurrent: 2})})

    await engine.tick()
    await engine.drain()
    expect(peak).toBe(2)
    expect(runTask).toHaveBeenCalledTimes(2)
  })

  it('re-resolves the target page id after the TTL (deleted+recreated page)', async () => {
    const {graph} = fakeGraph({blocks: {'b-new': {content: '[[claude]] x'}}})
    let currentPageId = 'page-v1'
    graph.resolvePageId = vi.fn(async () => currentPageId)
    const backlinksByPage: Record<string, Array<{id: string, deepLink: string}>> = {
      'page-v1': [],
      'page-v2': [{id: 'b-new', deepLink: 'link'}],
    }
    graph.backlinkSources = vi.fn(async (id: string) =>
      (backlinksByPage[id] ?? []).map(({id: sid, deepLink}) => ({id: sid, content: '[[claude]] x', types: [], deepLink, sourceFields: ['content']})))

    let clock = NOW
    const runTask = vi.fn(async () => okRun())
    const engine = createEngine({
      config: mentionConfig(), graph, state: memoryState(), runTask,
      deliverToChannel: vi.fn(async () => {}), mcpConfigPath: '/tmp/mcp.json', log: () => {}, now: () => clock,
    })

    await engine.tick()          // resolves page-v1, no backlinks
    await engine.drain()
    expect(runTask).not.toHaveBeenCalled()

    currentPageId = 'page-v2'     // page deleted + recreated
    clock += 11 * 60_000         // past the 10-min TTL
    await engine.tick()
    await engine.drain()
    expect(graph.resolvePageId).toHaveBeenCalledTimes(2)
    expect(runTask).toHaveBeenCalledTimes(1)
  })

  it('backs off when another daemon wins the claim race', async () => {
    const {graph, replies} = fakeGraph({
      backlinks: [{id: 'b-1'}],
      blocks: {'b-1': {content: '[[claude]] contested'}},
    })
    // Simulate a competing daemon overwriting the claim between our
    // write and the verify read.
    const realSetTaskProps = graph.setTaskProps
    graph.setTaskProps = async (id, args) => {
      await realSetTaskProps(id, args)
      if (args.status === 'running') {
        await realSetTaskProps(id, {status: 'running', watcher: 'other-daemon', nowMs: NOW + 5})
      }
    }
    const runTask = vi.fn(async () => okRun())
    const engine = engineWith({graph, runTask})

    await engine.tick()
    await engine.drain()

    expect(runTask).not.toHaveBeenCalled()
    expect(replies).toHaveLength(0)
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

  it('fires for a follow-up nested under a daemon reply (thread continuation)', async () => {
    const {graph, replies} = fakeGraph({
      backlinks: [{id: 'b-follow'}],
      blocks: {
        'reply-block': {content: 'earlier answer', properties: {[PROPS.reply]: true}},
        'b-follow': {content: '[[claude]] and one more thing', parentId: 'reply-block'},
      },
    })
    const runTask = vi.fn(async () => okRun())
    const engine = engineWith({graph, runTask})

    await engine.tick()
    await engine.drain()

    expect(runTask).toHaveBeenCalledTimes(1)
    expect(replies).toHaveLength(1)
  })

  it('never runs two concurrent --resume of the same session', async () => {
    const {graph} = fakeGraph({
      backlinks: [{id: 'b-f1'}, {id: 'b-f2'}],
      blocks: {
        'b-root': {content: 'root', properties: {[PROPS.session]: 'sess-shared'}},
        'b-f1': {content: '[[claude]] follow 1', parentId: 'b-root'},
        'b-f2': {content: '[[claude]] follow 2', parentId: 'b-root'},
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
    const engine = engineWith({graph, runTask})

    await engine.tick()
    await engine.drain()
    await engine.tick()
    await engine.drain()

    expect(peak).toBe(1)
    expect(runTask).toHaveBeenCalledTimes(2)
  })

  it('respects maxConcurrent across a tick without starving later mentions', async () => {
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
    await engine.tick()
    await engine.drain()
    expect(runTask).toHaveBeenCalledTimes(3)
  })

  it('stops launching once the runsPerHour budget is exhausted', async () => {
    const {graph} = fakeGraph({
      backlinks: [{id: 'b-1'}, {id: 'b-2'}, {id: 'b-3'}],
      blocks: {
        'b-1': {content: '[[claude]] 1'},
        'b-2': {content: '[[claude]] 2'},
        'b-3': {content: '[[claude]] 3'},
      },
    })
    const runTask = vi.fn(async () => okRun())
    const engine = engineWith({
      graph,
      runTask,
      config: mentionConfig({runsPerHour: 2, maxConcurrent: 10}),
    })

    await engine.tick()
    await engine.drain()
    await engine.tick()
    await engine.drain()

    expect(runTask).toHaveBeenCalledTimes(2)
  })

  it('carries the spend budget across a restart (persisted launch log)', async () => {
    const build = (state: ReturnType<typeof memoryState>) => {
      const {graph} = fakeGraph({
        backlinks: [{id: 'b-1'}, {id: 'b-2'}, {id: 'b-3'}],
        blocks: {
          'b-1': {content: '[[claude]] 1'},
          'b-2': {content: '[[claude]] 2'},
          'b-3': {content: '[[claude]] 3'},
        },
      })
      const runTask = vi.fn(async () => okRun())
      const engine = engineWith({graph, runTask, state, config: mentionConfig({runsPerHour: 2, maxConcurrent: 10})})
      return {engine, runTask}
    }

    const state = memoryState()
    const first = build(state)
    await first.engine.tick()
    await first.engine.drain()
    expect(first.runTask).toHaveBeenCalledTimes(2)

    // Fresh engine, SAME persisted state (simulates a restart): the
    // budget must NOT re-arm — an in-memory-only cap would fire 2 more.
    const second = build(state)
    await second.engine.tick()
    await second.engine.drain()
    expect(second.runTask).not.toHaveBeenCalled()
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
        watchers: [{kind: 'backlinks', name: 'mentions', target: 'claude', quietMs: 0, allowedTools: ['Bash(git:*)']}],
      }),
    })

    await engine.tick()
    await engine.drain()

    const tools = (runTask.mock.calls[0][0] as {allowedTools: string[]}).allowedTools
    expect(tools).toContain('mcp__km__get_block')
    expect(tools).toContain('Bash(git:*)')
  })
})

describe('backlink watcher baseline', () => {
  it('first tick baselines without firing; history never fires, later edits do', async () => {
    const {graph, blocks} = fakeGraph({
      backlinks: [{id: 'b-old'}, {id: 'b-new'}],
      blocks: {
        'b-old': {content: '[[claude]] ancient note', editedAtMs: NOW - 100_000},
        'b-new': {content: '[[claude]] typed after install', editedAtMs: NOW - 100_000},
      },
    })
    const runTask = vi.fn(async () => okRun())
    const state = memoryState([], {armBaselines: false})
    const engine = engineWith({graph, runTask, state})

    // First tick: establish the baseline, fire nothing — pointing a
    // watcher at an established page must not claim its history.
    await engine.tick()
    await engine.drain()
    expect(runTask).not.toHaveBeenCalled()
    expect(state.baselines.get('mentions')).toBe(NOW)

    // Second tick: both blocks predate the baseline — still nothing.
    await engine.tick()
    await engine.drain()
    expect(runTask).not.toHaveBeenCalled()

    // The user now edits one of them: that one (and only that one) fires.
    blocks.get('b-new')!.editedAtMs = NOW
    await engine.tick()
    await engine.drain()
    expect(runTask).toHaveBeenCalledTimes(1)
    expect(blocks.get('b-new')?.properties?.[PROPS.status]).toBe('done')
    expect(blocks.get('b-old')?.properties?.[PROPS.status]).toBeUndefined()
  })
})

describe('channel delivery (experimental)', () => {
  const channelConfig = () => parseConfig({
    watchers: [{kind: 'backlinks', name: 'mentions', target: 'claude', quietMs: 0, delivery: 'channel'}],
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
    expect(event.meta).toEqual({watcher: 'mentions', block_id: 'b-1', attempt: '1'})
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
  const queryConfig = (overrides: object = {}) => parseConfig({
    watchers: [{kind: 'query', name: 'inbox', sql: 'SELECT id FROM blocks', ...overrides}],
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

  it('caps rows per firing and notes the overflow in the prompt', async () => {
    const {graph} = fakeGraph()
    graph.sqlAll = vi.fn(async () => Array.from({length: 5}, (_, index) => ({id: `row-${index}`})))
    const state = memoryState()
    state.cursors.set('inbox', [])
    const runTask = vi.fn(async () => okRun())
    const engine = engineWith({graph, runTask, state, config: queryConfig({maxRowsPerFire: 2})})

    await engine.tick()
    await engine.drain()

    const prompt = (runTask.mock.calls[0][0] as {prompt: string}).prompt
    expect(prompt).toContain('row-0')
    expect(prompt).toContain('row-1')
    expect(prompt).not.toContain('row-2')
    expect(prompt).toContain('3 more new rows omitted')
    // Cursor still covers ALL rows — the omitted ones don't re-fire.
    expect(state.cursors.get('inbox')).toHaveLength(5)
  })

  it('channel delivery: keeps the cursor AND the spend budget when delivery fails', async () => {
    const {graph} = fakeGraph()
    graph.sqlAll = vi.fn(async () => [{id: 'a'}])
    const state = memoryState()
    state.cursors.set('inbox', [])
    const deliverToChannel = vi.fn(async () => { throw new Error('listener down') })
    const engine = engineWith({
      graph,
      deliverToChannel,
      state,
      config: queryConfig({delivery: 'channel'}),
    })

    await engine.tick()
    await engine.drain()
    expect(state.cursors.get('inbox')).toEqual([])   // NOT advanced
    // A failed POST bills nothing — it must not consume runsPerHour,
    // or a down listener drains the whole budget in ten polls.
    expect(state.launches).toHaveLength(0)

    // Listener comes back: the same row fires now, and THAT counts.
    const delivered: unknown[] = []
    const engine2 = engineWith({
      graph,
      deliverToChannel: vi.fn(async event => { delivered.push(event) }),
      state,
      config: queryConfig({delivery: 'channel'}),
    })
    await engine2.tick()
    await engine2.drain()
    expect(delivered).toHaveLength(1)
    expect(state.cursors.get('inbox')).toEqual(['a'])
    expect(state.launches).toHaveLength(1)
  })

  it('refuses an oversized query result instead of firing every tick', async () => {
    const {graph} = fakeGraph()
    graph.sqlAll = vi.fn(async () => Array.from({length: MAX_CURSOR_IDS + 1}, (_, index) => ({id: `r-${index}`})))
    const state = memoryState()
    const runTask = vi.fn(async () => okRun())
    const logs: string[] = []
    const engine = engineWith({graph, runTask, state, config: queryConfig(), log: line => logs.push(line)})

    await engine.tick()
    await engine.drain()
    await engine.tick()
    await engine.drain()

    expect(runTask).not.toHaveBeenCalled()
    expect(state.cursors.has('inbox')).toBe(false)
    expect(logs.some(line => line.includes('rows'))).toBe(true)
  })
})
