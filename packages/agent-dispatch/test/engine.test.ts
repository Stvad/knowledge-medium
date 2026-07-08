import {describe, expect, it, vi} from 'vitest'
import {createEngine, type EngineDeps} from '../src/engine'
import {parseConfig, PROPS} from '../src/config'
import type {BlockData, Graph} from '../src/graph'
import type {AgentRunResult} from '../src/runner'
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
  const propWrites: Array<{id: string, status: string, activity?: string | null}> = []
  const activityWrites: Array<{id: string, label: string}> = []
  const sessionWrites: Array<{id: string, session: string}> = []
  const contentUpdates: Array<{id: string, content: string}> = []
  const cancelClears: string[] = []

  const graph: Graph = {
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
      {id: rootId, parentId: null, content: blocks.get(rootId)?.content ?? ''} as BlockData,
    ],
    setTaskProps: async (id, args) => {
      const target = blocks.get(id) ?? {id, properties: {}}
      target.properties = {
        ...target.properties,
        [PROPS.status]: args.status,
        [PROPS.updatedAt]: args.nowMs,
        ...(args.watcher !== undefined ? {[PROPS.watcher]: args.watcher} : {}),
        ...(args.executor !== undefined ? {[PROPS.executor]: args.executor} : {}),
        ...(args.session ? {[PROPS.session]: args.session} : {}),
        ...(args.attempts !== undefined ? {[PROPS.attempts]: args.attempts} : {}),
        ...(args.error !== undefined ? {[PROPS.error]: args.error ?? ''} : {}),
        ...(args.activity !== undefined ? {[PROPS.activity]: args.activity ?? ''} : {}),
        ...(args.cancel !== undefined ? {[PROPS.cancel]: args.cancel ?? ''} : {}),
      }
      blocks.set(id, target)
      propWrites.push({id, status: args.status, activity: args.activity})
    },
    createReply: async (parentId, content) => {
      replies.push({parentId, content})
      const reply: BlockData = {id: `reply-${replies.length}`, parentId, content, properties: {[PROPS.reply]: true}}
      blocks.set(reply.id, reply)
      return reply
    },
    setActivity: async (id, label) => {
      const target = blocks.get(id) ?? {id, properties: {}}
      target.properties = {...target.properties, [PROPS.activity]: label}
      blocks.set(id, target)
      activityWrites.push({id, label})
    },
    setSession: async (id, session) => {
      const target = blocks.get(id) ?? {id, properties: {}}
      target.properties = {...target.properties, [PROPS.session]: session}
      blocks.set(id, target)
      sessionWrites.push({id, session})
    },
    clearCancel: async id => {
      // Merged single-key write: ONLY agent:cancel changes (like the bridge).
      const target = blocks.get(id) ?? {id, properties: {}}
      target.properties = {...target.properties, [PROPS.cancel]: ''}
      blocks.set(id, target)
      cancelClears.push(id)
    },
    updateBlockContent: async (id, content) => {
      const target = blocks.get(id) ?? {id, properties: {}}
      target.content = content
      blocks.set(id, target)
      contentUpdates.push({id, content})
    },
    sqlAll: vi.fn(async () => []),
    blockViews: async ids => new Map(
      ids.flatMap(id => {
        const target = blocks.get(id)
        return target ? [[id, {id, properties: target.properties ?? {}, editedAtMs: target.editedAtMs ?? null}] as const] : []
      }),
    ),
  }

  return {graph, blocks, replies, propWrites, activityWrites, sessionWrites, contentUpdates, cancelClears}
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

const okRun = (overrides: Partial<AgentRunResult> = {}): AgentRunResult => ({
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
    delay: async () => {}, // no-op so deliverReply retries don't slow tests
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
    expect(blocks.get('b-1')?.properties?.[PROPS.executor]).toBe('claude')
    expect(blocks.get('b-1')?.properties?.[PROPS.attempts]).toBe(1)

    const prompt = (runTask.mock.calls[0][0] as {prompt: string}).prompt
    expect(prompt).toContain('[[claude]] summarize inbox')
  })

  it('quotes the claimed block text in the log so a picked-up block is identifiable', async () => {
    // A block seen only through a page's backlink surface shows no status
    // chip, so the daemon log is the sole handle on what it just claimed —
    // a bare id is not enough to tell which block fired.
    const {graph} = fakeGraph({
      backlinks: [{id: 'b-1'}],
      blocks: {'b-1': {content: '[[browser emacs]]\ninvestigate the flaky test'}},
    })
    const logs: string[] = []
    const engine = engineWith({graph, log: line => logs.push(line)})

    await engine.tick()
    await engine.drain()

    const claimLog = logs.find(line => line.includes('claiming b-1'))
    // Whitespace-collapsed onto one line, and the text is present.
    expect(claimLog).toContain('"[[browser emacs]] investigate the flaky test"')
  })

  it('strips control bytes from the claim-log preview so synced block text cannot spoof the terminal', async () => {
    const {graph} = fakeGraph({
      backlinks: [{id: 'b-1'}],
      // ANSI ESC + NUL + BEL — control bytes a synced/imported block could
      // carry that would clear/spoof a `tail -f` of the daemon log.
      blocks: {'b-1': {content: 'a\u001b[2Jb\u0000 c\u0007'}},
    })
    const logs: string[] = []
    const engine = engineWith({graph, log: line => logs.push(line)})

    await engine.tick()
    await engine.drain()

    const claimLog = logs.find(line => line.includes('claiming b-1'))!
    // No control byte survives into the log line.
    expect([...claimLog].every(ch => (ch.codePointAt(0) ?? 0) >= 0x20)).toBe(true)
    // The ESC/NUL/BEL are stripped; the (harmless) printable remainder survives.
    expect(claimLog).toContain('"a[2Jb c"')
  })

  it('persists the session id mid-run, even when the terminal result loses it', async () => {
    const {graph, blocks, sessionWrites} = fakeGraph({
      backlinks: [{id: 'b-1'}],
      blocks: {'b-1': {content: '[[claude]] do a slow thing'}},
    })
    // The run emits its session on the first init line (via onEvent), then
    // is killed and returns a terminal result with NO sessionId — as a
    // timed-out/crashed run does. Only the EARLY write can have persisted
    // it, so this fails if onEvent stops recording the session.
    const runTask = vi.fn(async (opts: {onEvent?: (e: {kind: 'session', sessionId: string}) => void}) => {
      opts.onEvent?.({kind: 'session', sessionId: 'sess-live'})
      return okRun({ok: false, timedOut: true, sessionId: null, resultText: ''})
    })
    const engine = engineWith({graph, runTask})

    await engine.tick()
    await engine.drain()

    expect(sessionWrites).toEqual([{id: 'b-1', session: 'sess-live'}])
    expect(blocks.get('b-1')?.properties?.[PROPS.session]).toBe('sess-live')
    expect(blocks.get('b-1')?.properties?.[PROPS.status]).toBe('error')
  })

  it('a follow-up nested under a still-running parent does not resume its session concurrently', async () => {
    // Start with only the parent; the follow-up is created MID-RUN (below),
    // after the parent's session is already exposed on the block — the case
    // the early setSession opened up.
    const backlinks: Array<{id: string}> = [{id: 'parent'}]
    const {graph, blocks} = fakeGraph({
      backlinks,
      blocks: {parent: {content: '[[claude]] long parent task'}},
    })
    let releaseParent = () => {}
    const parentGate = new Promise<void>(resolve => { releaseParent = resolve })
    const runTask = vi.fn(async (opts: {prompt: string, onEvent?: (e: {kind: 'session', sessionId: string}) => void}) => {
      if (opts.prompt.includes('long parent task')) {
        opts.onEvent?.({kind: 'session', sessionId: 'sess-parent'}) // exposes the session mid-run
        await parentGate // stay in-flight, holding the session, until released
        return okRun({sessionId: 'sess-parent'})
      }
      return okRun({resultText: 'child reply', sessionId: 'sess-parent'})
    })
    const engine = engineWith({graph, runTask, config: mentionConfig({maxConcurrent: 5})})

    const parentTick = engine.tick()
    // Parent's session lands on the block the instant it streams.
    await vi.waitFor(() => expect(blocks.get('parent')?.properties?.[PROPS.session]).toBe('sess-parent'))

    // User adds a follow-up nested under the (still-running) parent.
    blocks.set('child', {id: 'child', parentId: 'parent', content: '[[claude]] quick follow-up', properties: {}, editedAtMs: NOW})
    backlinks.push({id: 'child'})

    // Tick claims pending work; let the follow-up's decision path settle
    // (all fakes resolve on the microtask queue, so a bounded flush is
    // deterministic). The duplicate-session guard must turn it away BEFORE
    // it claims — so it never writes a status and never resumes the live
    // session. Absent the guard, it claims (status:running) and starts a
    // concurrent `--resume`.
    await engine.tick()
    for (let i = 0; i < 50; i += 1) await Promise.resolve()

    expect(blocks.get('child')?.properties?.[PROPS.status]).toBeUndefined()
    expect(runTask).toHaveBeenCalledTimes(1) // only the parent

    releaseParent()
    await parentTick
    await engine.drain()
  })

  it('cancels a running task: aborts the run, parks it error:cancelled, and clears the flag', async () => {
    const {graph, blocks, replies} = fakeGraph({
      backlinks: [{id: 'b-1'}],
      blocks: {'b-1': {content: '[[claude]] long task'}},
    })
    let releaseRun = () => {}
    const runGate = new Promise<void>(resolve => { releaseRun = resolve })
    let sawAbort = false
    // The run hangs until aborted — exactly what killing the child does:
    // the abort ends it and it returns a non-ok result.
    const runTask = vi.fn(async (opts: {signal?: AbortSignal}) => {
      opts.signal?.addEventListener('abort', () => { sawAbort = true; releaseRun() })
      await runGate
      return okRun({ok: false, exitCode: null, timedOut: false, resultText: '', sessionId: 'sess-1'})
    })
    const engine = engineWith({graph, runTask})

    const tick1 = engine.tick()
    await vi.waitFor(() => expect(blocks.get('b-1')?.properties?.[PROPS.status]).toBe('running'))
    expect(runTask).toHaveBeenCalledTimes(1)

    // User hits Stop → the UI writes agent:cancel on the running block.
    const b1 = blocks.get('b-1')!
    b1.properties = {...b1.properties, [PROPS.cancel]: NOW}

    // Next tick detects the flag and aborts the in-flight run.
    await engine.tick()
    await vi.waitFor(() => expect(sawAbort).toBe(true))
    await tick1
    await engine.drain()

    expect(blocks.get('b-1')?.properties?.[PROPS.status]).toBe('error')
    expect(blocks.get('b-1')?.properties?.[PROPS.error]).toBe('cancelled')
    expect(blocks.get('b-1')?.properties?.[PROPS.cancel]).toBe('') // flag cleared, won't re-cancel a rerun
    expect(replies).toEqual([{parentId: 'b-1', content: '⏹️ agent-dispatch run cancelled'}])
    expect(runTask).toHaveBeenCalledTimes(1) // not re-run
  })

  it('cancels an in-flight run even after its [[claude]] link was edited away', async () => {
    // Regression: the cancel scan must key off the live run, not the
    // current backlink set. Once claimed, the user removes the mention —
    // the block drops out of backlinkSources but is still running, so Stop
    // must still reach it (else the child runs to completion/timeout).
    const {graph, blocks} = fakeGraph({
      backlinks: [{id: 'b-1'}],
      blocks: {'b-1': {content: '[[claude]] long task'}},
    })
    let releaseRun = () => {}
    const runGate = new Promise<void>(resolve => { releaseRun = resolve })
    let sawAbort = false
    const runTask = vi.fn(async (opts: {signal?: AbortSignal}) => {
      opts.signal?.addEventListener('abort', () => { sawAbort = true; releaseRun() })
      await runGate
      return okRun({ok: false, exitCode: null, timedOut: false, resultText: '', sessionId: 'sess-1'})
    })
    const engine = engineWith({graph, runTask})

    const tick1 = engine.tick()
    await vi.waitFor(() => expect(blocks.get('b-1')?.properties?.[PROPS.status]).toBe('running'))

    // The mention is edited out: b-1 no longer resolves as a backlink,
    // but the run (and its agent:status:running) persists.
    ;(graph.backlinkSources as ReturnType<typeof vi.fn>).mockResolvedValue([])
    const b1 = blocks.get('b-1')!
    b1.properties = {...b1.properties, [PROPS.cancel]: NOW}

    await engine.tick()
    await vi.waitFor(() => expect(sawAbort).toBe(true))
    await tick1
    await engine.drain()

    expect(blocks.get('b-1')?.properties?.[PROPS.status]).toBe('error')
    expect(blocks.get('b-1')?.properties?.[PROPS.error]).toBe('cancelled')
    expect(blocks.get('b-1')?.properties?.[PROPS.cancel]).toBe('')
    expect(runTask).toHaveBeenCalledTimes(1)
  })

  it('honors a Stop that lands before the run registers (during getSubtree)', async () => {
    // The controller is registered right after the claim, BEFORE getSubtree,
    // so a Stop in the claim→run window is still seen by the sweep. Without
    // that, this cancel would be dropped and the task would report `done`.
    const {graph, blocks} = fakeGraph({
      backlinks: [{id: 'b-1'}],
      blocks: {'b-1': {content: '[[claude]] x'}},
    })
    let releaseSubtree = () => {}
    const subtreeGate = new Promise<void>(resolve => { releaseSubtree = resolve })
    graph.getSubtree = vi.fn(async () => {
      await subtreeGate
      return [{id: 'b-1', parentId: null, content: 'x'} as BlockData]
    })
    // Fake run mirrors execProcess's pre-abort short-circuit: an
    // already-aborted signal returns a non-ok, no-output result.
    const runTask = vi.fn(async (opts: {signal?: AbortSignal}) =>
      okRun(opts.signal?.aborted
        ? {ok: false, exitCode: null, timedOut: false, resultText: '', sessionId: 'sess-1'}
        : {ok: true, exitCode: 0, timedOut: false, resultText: 'hi', sessionId: 'sess-1'}))
    const engine = engineWith({graph, runTask})

    const tick1 = engine.tick()
    // Claimed + parked in getSubtree — the controller is already registered.
    await vi.waitFor(() => expect(blocks.get('b-1')?.properties?.[PROPS.status]).toBe('running'))
    blocks.get('b-1')!.properties = {...blocks.get('b-1')!.properties, [PROPS.cancel]: NOW}

    await engine.tick() // sweep aborts the registered controller
    releaseSubtree()
    await tick1
    await engine.drain()

    expect(runTask.mock.calls[0]![0].signal!.aborted).toBe(true)
    expect(blocks.get('b-1')?.properties?.[PROPS.status]).toBe('error')
    expect(blocks.get('b-1')?.properties?.[PROPS.error]).toBe('cancelled')
    expect(blocks.get('b-1')?.properties?.[PROPS.cancel]).toBe('')
  })

  it('clears an un-actionable agent:cancel with a cancel-only write (never touches status)', async () => {
    // A channel-delivered task the daemon doesn't own — or a run stranded by
    // a hard kill — is status:running with a Stop flag but no controller. The
    // scan clears the inert flag so the chip un-sticks. Crucially it writes
    // ONLY cancel: a status write would race the ambient session's concurrent
    // status:done and revert it → the stale-running sweep would then redeliver
    // (duplicate work). So no setTaskProps here, and status/updatedAt are left
    // exactly as-is.
    const {graph, blocks, propWrites, cancelClears} = fakeGraph({
      backlinks: [{id: 'b-1'}],
      blocks: {'b-1': {content: '[[claude]] x', editedAtMs: NOW - 10_000, properties: {
        [PROPS.status]: 'running', [PROPS.updatedAt]: NOW - 1_000, [PROPS.cancel]: NOW,
      }}},
    })
    const runTask = vi.fn(async () => okRun())
    const engine = engineWith({graph, runTask})

    await engine.tick()
    await engine.drain()

    expect(cancelClears).toEqual(['b-1'])                       // cancel-only clear fired
    expect(propWrites.filter(w => w.id === 'b-1')).toEqual([])  // no status write → nothing to revert
    expect(blocks.get('b-1')?.properties?.[PROPS.cancel]).toBe('')
    expect(blocks.get('b-1')?.properties?.[PROPS.status]).toBe('running')      // untouched
    expect(blocks.get('b-1')?.properties?.[PROPS.updatedAt]).toBe(NOW - 1_000) // untouched
    expect(runTask).not.toHaveBeenCalled()
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

  it('clears agent:cancel on the infra-error path so a retry is not aborted', async () => {
    // If Stop set agent:cancel and the run then takes the infra-catch
    // (e.g. the child was aborted, then a bridge write failed), the flag
    // must be cleared like the normal terminal writes — else the next
    // retry inherits it and is aborted on its first tick.
    const {graph, blocks} = fakeGraph({
      backlinks: [{id: 'b-1'}],
      blocks: {'b-1': {content: '[[claude]] infra', properties: {[PROPS.cancel]: NOW}}},
    })
    graph.getSubtree = vi.fn(async () => { throw new Error('bridge blipped') })
    const engine = engineWith({graph})

    await engine.tick()
    await engine.drain()

    expect(blocks.get('b-1')?.properties?.[PROPS.status]).toBe('error')
    expect(blocks.get('b-1')?.properties?.[PROPS.cancel]).toBe('')
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

  it('never resumes a session across executors; stores codex threads executor-tagged', async () => {
    // A thread started by the claude executor (bare session id) followed
    // up under a codex watcher: `codex exec resume <claude-id>` would
    // fail the run outright, so it must start FRESH instead.
    const codexConfig = () => parseConfig({
      watchers: [{kind: 'backlinks', name: 'mentions', target: 'claude', quietMs: 0, runner: {executor: 'codex'}}],
    })
    {
      const {graph, blocks} = fakeGraph({
        backlinks: [{id: 'b-child'}],
        blocks: {
          'b-root': {content: '[[claude]] original', properties: {[PROPS.status]: 'done', [PROPS.session]: 'claude-sess'}},
          'b-child': {content: '[[claude]] follow up', parentId: 'b-root'},
        },
      })
      const runTask = vi.fn(async () => okRun({sessionId: 'thread-1'}))
      const engine = engineWith({graph, runTask, config: codexConfig()})
      await engine.tick()
      await engine.drain()
      expect((runTask.mock.calls[0][0] as {resumeSessionId?: string}).resumeSessionId).toBeUndefined()
      // The new codex thread is stored tagged, so a claude follow-up
      // won't try to `--resume` it either.
      expect(blocks.get('b-child')?.properties?.[PROPS.session]).toBe('codex:thread-1')
    }
    // A codex-tagged session under a codex watcher resumes with the BARE id.
    {
      const {graph} = fakeGraph({
        backlinks: [{id: 'b-child'}],
        blocks: {
          'b-root': {content: '[[claude]] original', properties: {[PROPS.status]: 'done', [PROPS.session]: 'codex:thread-9'}},
          'b-child': {content: '[[claude]] follow up', parentId: 'b-root'},
        },
      })
      const runTask = vi.fn(async () => okRun())
      const engine = engineWith({graph, runTask, config: codexConfig()})
      await engine.tick()
      await engine.drain()
      expect((runTask.mock.calls[0][0] as {resumeSessionId?: string}).resumeSessionId).toBe('thread-9')
    }
    // A codex-tagged session under the CLAUDE executor starts fresh.
    {
      const {graph} = fakeGraph({
        backlinks: [{id: 'b-child'}],
        blocks: {
          'b-root': {content: '[[claude]] original', properties: {[PROPS.status]: 'done', [PROPS.session]: 'codex:thread-9'}},
          'b-child': {content: '[[claude]] follow up', parentId: 'b-root'},
        },
      })
      const runTask = vi.fn(async () => okRun())
      const engine = engineWith({graph, runTask})
      await engine.tick()
      await engine.drain()
      expect((runTask.mock.calls[0][0] as {resumeSessionId?: string}).resumeSessionId).toBeUndefined()
    }
  })

  it('refuses to resume an argv-injection-shaped session id (starts fresh)', async () => {
    // agent:session is a plain block property any MCP update_block caller
    // can write; a planted flag-shaped value would otherwise ride into the
    // resume argv (`codex exec resume <id>` / `--resume <id>`) as a live
    // option. Anything that isn't UUID/token-shaped must start fresh.
    for (const planted of ['codex:-c=tools.web_search="live"', '--dangerously-bypass', 'has space', 'a;b']) {
      const executor = planted.startsWith('codex:') ? 'codex' : 'claude'
      const {graph} = fakeGraph({
        backlinks: [{id: 'b-child'}],
        blocks: {
          'b-root': {content: '[[claude]] original', properties: {[PROPS.status]: 'done', [PROPS.session]: planted}},
          'b-child': {content: '[[claude]] follow up', parentId: 'b-root'},
        },
      })
      const runTask = vi.fn(async () => okRun())
      const engine = engineWith({
        graph,
        runTask,
        config: parseConfig({watchers: [{kind: 'backlinks', name: 'mentions', target: 'claude', quietMs: 0, runner: {executor}}]}),
      })
      await engine.tick()
      await engine.drain()
      expect((runTask.mock.calls[0]?.[0] as {resumeSessionId?: string} | undefined)?.resumeSessionId).toBeUndefined()
    }
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

  it('refunds the budget slot when a same-session duplicate bails without spawning', async () => {
    const {graph} = fakeGraph({
      backlinks: [{id: 'b-f1'}, {id: 'b-f2'}],
      blocks: {
        'b-root': {content: 'root', properties: {[PROPS.session]: 'sess-shared'}},
        'b-f1': {content: '[[claude]] follow 1', parentId: 'b-root'},
        'b-f2': {content: '[[claude]] follow 2', parentId: 'b-root'},
      },
    })
    const state = memoryState()
    const runTask = vi.fn(async () => okRun())
    const engine = engineWith({graph, runTask, state, config: mentionConfig({runsPerHour: 2, maxConcurrent: 10})})

    // Both follow-ups pass the pre-filter, but only one can hold the
    // session guard — the duplicate spawns nothing, so its budget slot
    // must come back or a tight runsPerHour defers real work for an hour.
    await engine.tick()
    await engine.drain()
    expect(runTask).toHaveBeenCalledTimes(1)
    expect(state.launches).toHaveLength(1)

    // The refunded slot lets the second follow-up run within the budget.
    await engine.tick()
    await engine.drain()
    expect(runTask).toHaveBeenCalledTimes(2)
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

  it('passes the km MCP allowlist plus default web tools plus watcher extras to the run', async () => {
    const {graph} = fakeGraph({
      backlinks: [{id: 'b-1'}],
      blocks: {'b-1': {content: '[[claude]] with tools'}},
    })
    const runTask = vi.fn(async () => okRun())
    const engine = engineWith({
      graph,
      runTask,
      config: parseConfig({
        watchers: [{
          kind: 'backlinks',
          name: 'mentions',
          target: 'claude',
          quietMs: 0,
          runner: {executor: 'claude', allowedTools: ['Bash(git:*)']},
        }],
      }),
    })

    await engine.tick()
    await engine.drain()

    const tools = (runTask.mock.calls[0][0] as {allowedTools: string[]}).allowedTools
    expect(tools).toContain('mcp__km__get_block')
    expect(tools).toContain('WebSearch')
    expect(tools).toContain('WebFetch')
    expect(tools).toContain('Bash(git:*)')
  })

  it('defaultAllowedTools: [] keeps runs graph-only (web-tools opt-out)', async () => {
    const {graph} = fakeGraph({
      backlinks: [{id: 'b-1'}],
      blocks: {'b-1': {content: '[[claude]] sensitive graph'}},
    })
    const runTask = vi.fn(async () => okRun())
    const engine = engineWith({
      graph,
      runTask,
      config: parseConfig({
        defaultAllowedTools: [],
        watchers: [{kind: 'backlinks', name: 'mentions', target: 'claude', quietMs: 0}],
      }),
    })

    await engine.tick()
    await engine.drain()

    const tools = (runTask.mock.calls[0][0] as {allowedTools: string[]}).allowedTools
    expect(tools).toContain('mcp__km__get_block')
    expect(tools).not.toContain('WebSearch')
    expect(tools).not.toContain('WebFetch')
  })

  it('a watcher with runner.executor: "codex" produces codex run options', async () => {
    const {graph} = fakeGraph({
      backlinks: [{id: 'b-1'}],
      blocks: {'b-1': {content: '[[claude]] via codex'}},
    })
    const runTask = vi.fn(async () => okRun())
    const engine = engineWith({
      graph,
      runTask,
      config: parseConfig({
        watchers: [{
          kind: 'backlinks',
          name: 'mentions',
          target: 'claude',
          quietMs: 0,
          runner: {
            executor: 'codex',
            sandbox: 'workspace-write',
            addDirs: ['/private/tmp'],
            networkAccess: true,
            approvalPolicy: 'on-request',
          },
        }],
      }),
    })

    await engine.tick()
    await engine.drain()

    expect(runTask.mock.calls[0][0]).toMatchObject({
      executor: 'codex',
      allowedTools: [],
      codexSandbox: 'workspace-write',
      codexAddDirs: ['/private/tmp'],
      codexNetworkAccess: true,
      codexApprovalPolicy: 'on-request',
    })
  })
})

describe('live progress streaming', () => {
  it('activity events write setActivity on label CHANGE only, and the terminal write clears it', async () => {
    const {graph, blocks, activityWrites, propWrites} = fakeGraph({
      backlinks: [{id: 'b-1'}],
      blocks: {'b-1': {content: '[[claude]] research this'}},
    })
    const runTask = vi.fn(async (options: {onEvent?: (event: {kind: string, label?: string}) => void}) => {
      options.onEvent?.({kind: 'activity', label: 'km: search'})
      options.onEvent?.({kind: 'activity', label: 'km: search'}) // duplicate — must not re-write
      options.onEvent?.({kind: 'activity', label: 'Searching the web'})
      return okRun()
    })
    const engine = engineWith({graph, runTask})

    await engine.tick()
    await engine.drain()

    expect(activityWrites).toEqual([
      {id: 'b-1', label: 'km: search'},
      {id: 'b-1', label: 'Searching the web'},
    ])
    // Terminal write clears the transient label so it never outlives the run.
    expect(propWrites.at(-1)).toMatchObject({status: 'done', activity: null})
    expect(blocks.get('b-1')?.properties?.[PROPS.activity]).toBe('')
  })

  it('streamReply watcher: early reply block, throttled text updates, final text replaces it, no duplicate reply', async () => {
    const {graph, blocks, replies, contentUpdates} = fakeGraph({
      backlinks: [{id: 'b-1'}],
      blocks: {'b-1': {content: '[[claude]] write something long'}},
    })
    let clock = NOW
    const runTask = vi.fn(async (options: {onEvent?: (event: {kind: string, text?: string}) => void}) => {
      options.onEvent?.({kind: 'text', text: 'Once up'}) // t+0: first write always allowed
      clock += 500
      options.onEvent?.({kind: 'text', text: 'Once upon a'}) // t+500: throttled, skipped
      clock += 1_100
      options.onEvent?.({kind: 'text', text: 'Once upon a time'}) // t+1600: past 1.5s, writes
      return okRun({resultText: 'Once upon a time, the end.'})
    })
    const engine = createEngine({
      config: parseConfig({
        watchers: [{kind: 'backlinks', name: 'mentions', target: 'claude', quietMs: 0, streamReply: true}],
      }),
      state: memoryState(),
      graph,
      runTask,
      deliverToChannel: vi.fn(async () => {}),
      mcpConfigPath: '/tmp/mcp.json',
      log: () => {},
      now: () => clock,
    })

    await engine.tick()
    await engine.drain()

    // Exactly one reply block — created early, never a second one.
    expect(replies).toHaveLength(1)
    expect(replies[0]).toMatchObject({parentId: 'b-1', content: '💭 Claude is working…'})

    // Throttled: only the first and third text events produced a streaming
    // write; the run's own final write (always unconditional) lands after.
    expect(contentUpdates.map(update => update.content)).toEqual([
      'Once up', 'Once upon a time', 'Once upon a time, the end.',
    ])
    // All writes landed on the SAME early-created reply block.
    const replyIds = new Set(contentUpdates.map(update => update.id))
    expect(replyIds.size).toBe(1)
    const finalReplyId = contentUpdates.at(-1)!.id
    expect(blocks.get(finalReplyId)?.content).toBe('Once upon a time, the end.')
  })

  it('default (non-stream) watcher: no early reply, a single createReply at the end', async () => {
    const {graph, replies, contentUpdates} = fakeGraph({
      backlinks: [{id: 'b-1'}],
      blocks: {'b-1': {content: '[[claude]] quick one'}},
    })
    const runTask = vi.fn(async (options: {onEvent?: (event: {kind: string, text?: string}) => void}) => {
      options.onEvent?.({kind: 'text', text: 'partial'}) // ignored: streamReply is off
      return okRun({resultText: 'final'})
    })
    const engine = engineWith({graph, runTask})

    await engine.tick()
    await engine.drain()

    expect(contentUpdates).toHaveLength(0)
    expect(replies).toEqual([{parentId: 'b-1', content: 'final'}])
  })

  it('failure with streamReply: the warning text lands in the streamed block, not a new one', async () => {
    const {graph, blocks, replies, contentUpdates} = fakeGraph({
      backlinks: [{id: 'b-1'}],
      blocks: {'b-1': {content: '[[claude]] break'}},
    })
    const engine = engineWith({
      graph,
      runTask: vi.fn(async () => okRun({ok: false, exitCode: 1, stderr: 'boom', resultText: ''})),
      config: parseConfig({
        watchers: [{kind: 'backlinks', name: 'mentions', target: 'claude', quietMs: 0, streamReply: true}],
      }),
    })

    await engine.tick()
    await engine.drain()

    expect(replies).toHaveLength(1) // the early streamed reply — no second block
    const replyId = contentUpdates.at(-1)!.id
    expect(blocks.get(replyId)?.content).toContain('run failed')
    expect(blocks.get(replyId)?.content).toContain('boom')
    expect(blocks.get('b-1')?.properties?.[PROPS.status]).toBe('error')
  })

  it('failure with a DELETED streamed placeholder: failure note falls back to a new reply, run reason preserved', async () => {
    const {graph, blocks, replies} = fakeGraph({
      backlinks: [{id: 'b-1'}],
      blocks: {'b-1': {content: '[[claude]] break'}},
    })
    // The user deleted the placeholder mid-run: content updates to any
    // reply block fail; createReply still works.
    graph.updateBlockContent = async id => {
      throw new Error(`block not found: ${id}`)
    }
    const engine = engineWith({
      graph,
      runTask: vi.fn(async () => okRun({ok: false, exitCode: 1, stderr: 'boom', resultText: ''})),
      config: parseConfig({
        watchers: [{kind: 'backlinks', name: 'mentions', target: 'claude', quietMs: 0, streamReply: true}],
      }),
    })

    await engine.tick()
    await engine.drain()

    // Placeholder + the fallback failure note.
    expect(replies).toHaveLength(2)
    expect(replies[1]!.content).toContain('run failed')
    expect(replies[1]!.content).toContain('boom')
    // Props record the RUN failure — not an infra error about the
    // missing reply block.
    expect(blocks.get('b-1')?.properties?.[PROPS.status]).toBe('error')
    expect(blocks.get('b-1')?.properties?.[PROPS.error]).toContain('boom')
  })

  it('failure after streaming: preserves the billed partial and appends the note', async () => {
    const {graph, blocks, contentUpdates} = fakeGraph({
      backlinks: [{id: 'b-1'}],
      blocks: {'b-1': {content: '[[claude]] long task'}},
    })
    const runTask = vi.fn(async (options: {onEvent?: (event: {kind: string, text?: string}) => void}) => {
      options.onEvent?.({kind: 'text', text: 'Here is most of the answer'}) // billed, streamed
      return okRun({ok: false, timedOut: true, resultText: ''})
    })
    const engine = engineWith({
      graph, runTask,
      config: parseConfig({watchers: [{kind: 'backlinks', name: 'mentions', target: 'claude', quietMs: 0, streamReply: true}]}),
    })

    await engine.tick()
    await engine.drain()

    const finalContent = blocks.get(contentUpdates.at(-1)!.id)?.content ?? ''
    expect(finalContent).toContain('Here is most of the answer') // partial NOT discarded
    expect(finalContent).toContain('timed out')                   // note appended
    expect(blocks.get('b-1')?.properties?.[PROPS.status]).toBe('error')
  })

  it('transient final-write error does NOT duplicate the reply (only not-found falls back)', async () => {
    const {graph, blocks, replies} = fakeGraph({
      backlinks: [{id: 'b-1'}],
      blocks: {'b-1': {content: '[[claude]] ok task'}},
    })
    // A transient bridge blip on the final write — the placeholder still
    // exists. Must NOT create a second reply block.
    graph.updateBlockContent = async () => { throw new Error('bridge command timed out') }
    const engine = engineWith({
      graph,
      runTask: vi.fn(async () => okRun({resultText: 'the answer'})),
      config: parseConfig({watchers: [{kind: 'backlinks', name: 'mentions', target: 'claude', quietMs: 0, streamReply: true}]}),
    })

    await engine.tick()
    await engine.drain()

    // Only the early placeholder — the failed update rethrew into the
    // infra catch, which also can't write, so no duplicate reply block.
    expect(replies).toHaveLength(1)
    expect(replies[0]!.content).toBe('💭 Claude is working…')
    // The run still lands in a terminal error state (props stick).
    expect(blocks.get('b-1')?.properties?.[PROPS.status]).toBe('error')
  })

  it('transient blip on the terminal props-write (non-stream) does NOT duplicate the delivered answer', async () => {
    const {graph, replies} = fakeGraph({
      backlinks: [{id: 'b-1'}],
      blocks: {'b-1': {content: '[[claude]] ok task'}},
    })
    // The reply lands fine; the blip hits the `status:done` props write
    // that FOLLOWS it — the case the shared deliverReply refactor missed.
    const realSetTaskProps = graph.setTaskProps
    graph.setTaskProps = async (id, args) => {
      if (args.status === 'done') throw new Error('bridge command timed out')
      return realSetTaskProps(id, args)
    }
    const engine = engineWith({
      graph,
      runTask: vi.fn(async () => okRun({resultText: 'the answer'})),
    })

    await engine.tick()
    await engine.drain()

    // Exactly one reply — the answer. The infra-catch must not post a
    // second (infra-error) reply just because the props write blipped.
    expect(replies).toEqual([{parentId: 'b-1', content: 'the answer'}])
  })

  it('transient blip on the terminal props-write (streamReply) does NOT clobber the delivered answer', async () => {
    const {graph, blocks, replies, contentUpdates} = fakeGraph({
      backlinks: [{id: 'b-1'}],
      blocks: {'b-1': {content: '[[claude]] ok task'}},
    })
    const realSetTaskProps = graph.setTaskProps
    graph.setTaskProps = async (id, args) => {
      if (args.status === 'done') throw new Error('bridge command timed out')
      return realSetTaskProps(id, args)
    }
    const engine = engineWith({
      graph,
      runTask: vi.fn(async () => okRun({resultText: 'the answer'})),
      config: parseConfig({watchers: [{kind: 'backlinks', name: 'mentions', target: 'claude', quietMs: 0, streamReply: true}]}),
    })

    await engine.tick()
    await engine.drain()

    // The streamed placeholder holds the final answer — the infra-catch
    // must NOT overwrite it with the infrastructure-error note.
    expect(replies).toHaveLength(1)
    const replyId = contentUpdates.at(-1)!.id
    expect(blocks.get(replyId)?.content).toBe('the answer')
  })

  it('transient blip on the terminal streamReply write is retried and recovers the billed answer', async () => {
    const {graph, blocks, replies, contentUpdates} = fakeGraph({
      backlinks: [{id: 'b-1'}],
      blocks: {'b-1': {content: '[[claude]] ok task'}},
    })
    // The idempotent streamed update is safe to retry: one transient blip,
    // then it lands. The answer must be recovered, not lost to status:error.
    const realUpdate = graph.updateBlockContent
    let updateCalls = 0
    graph.updateBlockContent = async (id, content) => {
      updateCalls += 1
      if (updateCalls === 1) throw new Error('bridge command timed out')
      return realUpdate(id, content)
    }
    const engine = engineWith({
      graph,
      runTask: vi.fn(async () => okRun({resultText: 'the answer'})),
      config: parseConfig({watchers: [{kind: 'backlinks', name: 'mentions', target: 'claude', quietMs: 0, streamReply: true}]}),
    })

    await engine.tick()
    await engine.drain()

    // Retry landed the answer on the existing placeholder — no fallback
    // createReply (still one reply block), terminal state is done.
    expect(replies).toHaveLength(1)
    const replyId = contentUpdates.at(-1)!.id
    expect(blocks.get(replyId)?.content).toBe('the answer')
    expect(blocks.get('b-1')?.properties?.[PROPS.status]).toBe('done')
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

describe('backlink watcher baseline (stamp timing)', () => {
  it('stamps the baseline BEFORE the first scan so mid-scan edits still fire', async () => {
    let clock = NOW
    const {graph} = fakeGraph({
      backlinks: [{id: 'b-mid'}],
      // Edited DURING the first scan (after tick start, before the
      // baseline write) — a post-scan stamp would orphan it forever.
      blocks: {'b-mid': {content: '[[claude]] typed mid-scan', editedAtMs: NOW + 500}},
    })
    const innerSources = graph.backlinkSources
    graph.backlinkSources = vi.fn(async (id: string) => {
      clock += 1_000 // the bridge scan takes a while
      return innerSources(id)
    })
    const state = memoryState([], {armBaselines: false})
    const runTask = vi.fn(async () => okRun())
    const engine = createEngine({
      config: mentionConfig(), graph, state, runTask,
      deliverToChannel: vi.fn(async () => {}), mcpConfigPath: '/tmp/mcp.json', log: () => {}, now: () => clock,
    })

    await engine.tick()
    await engine.drain()
    expect(runTask).not.toHaveBeenCalled()
    expect(state.baselines.get('mentions')).toBe(NOW) // tick start, not post-scan

    await engine.tick()
    await engine.drain()
    expect(runTask).toHaveBeenCalledTimes(1)
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
