import {describe, expect, it, vi} from 'vitest'
import {createEngine, type EngineDeps} from '../src/engine'
import {parseConfig, PROPS} from '../src/config'
import type {BlockData, Graph} from '../src/graph'
import type {AgentRunResult} from '../src/runner'
import type {StateStore} from '../src/state'
import {MAX_ATTEMPTS, MAX_CURSOR_IDS} from '../src/watchers'
import {withRunFailure} from '../src/runFailure'

const NOW = 1_800_000_000_000

interface FakeGraphSeed {
  pageId?: string
  backlinks?: Array<{id: string, deepLink?: string}>
  /** Per-TARGET backlinks, for the multi-watcher tests: with this set,
   *  each watcher's `target` resolves to its own page and sees only its
   *  own blocks (the flat `backlinks` above hands every watcher the same
   *  list, which is all a single-watcher test needs). */
  backlinksByTarget?: Record<string, Array<{id: string, deepLink?: string}>>
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
  const reconciles: Array<{parentId: string, markdown: string, replyKey: string, shape: 'outline' | 'block', final: boolean}> = []
  const propWrites: Array<{id: string, status: string, activity?: string | null}> = []
  const activityWrites: Array<{id: string, label: string}> = []
  const sessionWrites: Array<{id: string, session: string}> = []
  const contentUpdates: Array<{id: string, content: string}> = []
  const cancelClears: string[] = []

  const graph: Graph = {
    resolvePageId: vi.fn(async (target: string) =>
      seed.backlinksByTarget ? `page:${target}` : (seed.pageId ?? 'page-claude')),
    backlinkSources: vi.fn(async (pageId: string) =>
      (seed.backlinksByTarget?.[pageId.replace(/^page:/, '')] ?? seed.backlinks ?? []).map(({id, deepLink}) => ({
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
        ...(args.resumeOptions ? {[PROPS.resumeOptions]: args.resumeOptions} : {}),
        ...(args.attempts !== undefined ? {[PROPS.attempts]: args.attempts} : {}),
        ...(args.error !== undefined ? {[PROPS.error]: args.error ?? ''} : {}),
        ...(args.activity !== undefined ? {[PROPS.activity]: args.activity ?? ''} : {}),
        ...(args.cancel !== undefined ? {[PROPS.cancel]: args.cancel ?? ''} : {}),
        ...(args.retryAfter !== undefined ? {[PROPS.retryAfter]: args.retryAfter ?? 0} : {}),
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
    reconcileReplyTree: async (parentId, markdown, {replyKey, shape, final}) => {
      reconciles.push({parentId, markdown, replyKey, shape, final: final ?? false})
    },
    setActivity: async (id, label) => {
      const target = blocks.get(id) ?? {id, properties: {}}
      target.properties = {...target.properties, [PROPS.activity]: label}
      blocks.set(id, target)
      activityWrites.push({id, label})
    },
    setSession: async (id, session, resumeOptions) => {
      const target = blocks.get(id) ?? {id, properties: {}}
      target.properties = {
        ...target.properties,
        [PROPS.session]: session,
        ...(resumeOptions ? {[PROPS.resumeOptions]: resumeOptions} : {}),
      }
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

  return {graph, blocks, replies, reconciles, propWrites, activityWrites, sessionWrites, contentUpdates, cancelClears}
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
  ok: true, resultText: 'Reply text', sessionId: 'sess-1', exitCode: 0, timedOut: false, stderr: '',
  failureText: '', raw: {},
  ...overrides,
})

/** A run that never reached the model: out of credits. The shape
 *  `claude -p` produces when a subscription is spent. */
const outOfCreditsRun = (overrides: Partial<AgentRunResult> = {}): AgentRunResult => okRun({
  ok: false,
  resultText: '',
  sessionId: null,
  exitCode: 1,
  stderr: 'Claude AI usage limit reached|1800003600',
  failureText: 'Claude AI usage limit reached|1800003600',
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
    const {graph, blocks, replies, reconciles, propWrites} = fakeGraph({
      backlinks: [{id: 'b-1'}],
      blocks: {'b-1': {content: '[[claude]] summarize inbox'}},
    })
    const runTask = vi.fn(async () => okRun())
    const engine = engineWith({graph, runTask})

    await engine.tick()
    await engine.drain()

    expect(propWrites.map(write => write.status)).toEqual(['running', 'done'])
    // splitReply defaults on: one terminal reconcile of the reply subtree,
    // split along the outline (shape 'outline'), keyed by attempt.
    expect(reconciles).toEqual([
      {parentId: 'b-1', markdown: 'Reply text', replyKey: 'reply:b-1:1:0', shape: 'outline', final: true},
    ])
    expect(replies).toEqual([])
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
    const {graph, blocks, reconciles} = fakeGraph({
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
    // A cancelled run never splits — the note lands as a single block.
    expect(reconciles).toEqual([
      {parentId: 'b-1', markdown: '⏹️ agent-dispatch run cancelled', replyKey: 'reply:b-1:1:0', shape: 'block', final: true},
    ])
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
    const {graph, reconciles} = fakeGraph({
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
    expect(reconciles).toHaveLength(1)
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
    const {graph, blocks, reconciles} = fakeGraph({
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
    // A failed run never splits — the note lands as a single block.
    expect(reconciles[0].shape).toBe('block')
    expect(reconciles[0].markdown).toContain('run failed')
    expect(reconciles[0].markdown).toContain('credit exhausted')
  })

  it('leaves a visible reply even when infrastructure fails mid-task', async () => {
    const {graph, blocks, reconciles} = fakeGraph({
      backlinks: [{id: 'b-1'}],
      blocks: {'b-1': {content: '[[claude]] infra'}},
    })
    graph.getSubtree = vi.fn(async () => { throw new Error('bridge blipped') })
    const engine = engineWith({graph})

    await engine.tick()
    await engine.drain()

    expect(blocks.get('b-1')?.properties?.[PROPS.status]).toBe('error')
    expect(reconciles[0].markdown).toContain('infrastructure error')
    expect(reconciles[0].markdown).toContain('bridge blipped')
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
    const {graph, reconciles} = fakeGraph({
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
    expect(reconciles).toHaveLength(1)
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
            approvalsReviewer: 'auto_review',
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
      codexApprovalsReviewer: 'auto_review',
    })
  })

  it('persists codex resume options next to the executor-scoped session id', async () => {
    const {graph, blocks} = fakeGraph({
      backlinks: [{id: 'b-1'}],
      blocks: {'b-1': {content: '[[claude]] via codex'}},
    })
    const runTask = vi.fn(async () => okRun({sessionId: 'thread-1'}))
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
            cwd: '/Users/vlad/project',
            model: 'gpt-5-codex',
            sandbox: 'workspace-write',
            addDirs: ['/private/tmp'],
            networkAccess: true,
            approvalPolicy: 'on-request',
            approvalsReviewer: 'auto_review',
          },
        }],
      }),
    })

    await engine.tick()
    await engine.drain()

    expect(blocks.get('b-1')?.properties?.[PROPS.session]).toBe('codex:thread-1')
    expect(blocks.get('b-1')?.properties?.[PROPS.resumeOptions]).toEqual({
      version: 1,
      executor: 'codex',
      model: 'gpt-5-codex',
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

  it('streamReply: placeholder, throttled text reconciles, then the terminal reconcile — all one keyed subtree', async () => {
    const {graph, reconciles} = fakeGraph({
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
        watchers: [{kind: 'backlinks', name: 'mentions', target: 'claude', quietMs: 0, streamReply: true, splitReply: false}],
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

    // Placeholder, then throttled streamed reconciles (t+500 skipped), then
    // the terminal reconcile — every one the SAME keyed single-block subtree
    // (splitReply off → shape 'block'), so the reply grows in place.
    expect(reconciles.map(r => ({markdown: r.markdown, final: r.final}))).toEqual([
      {markdown: '💭 Claude is working…', final: false},
      {markdown: 'Once up', final: false},
      {markdown: 'Once upon a time', final: false},
      {markdown: 'Once upon a time, the end.', final: true},
    ])
    expect(new Set(reconciles.map(r => r.replyKey))).toEqual(new Set(['reply:b-1:1:0']))
    expect(reconciles.every(r => r.shape === 'block')).toBe(true)
  })

  it('default (non-stream) watcher: no streamed reconciles, a single terminal reconcile', async () => {
    const {graph, reconciles} = fakeGraph({
      backlinks: [{id: 'b-1'}],
      blocks: {'b-1': {content: '[[claude]] quick one'}},
    })
    const runTask = vi.fn(async (options: {onEvent?: (event: {kind: string, text?: string}) => void}) => {
      options.onEvent?.({kind: 'text', text: 'partial'}) // ignored: streamReply is off
      return okRun({resultText: 'final'})
    })
    const engine = engineWith({
      graph, runTask,
      config: parseConfig({watchers: [{kind: 'backlinks', name: 'mentions', target: 'claude', quietMs: 0, splitReply: false}]}),
    })

    await engine.tick()
    await engine.drain()

    expect(reconciles).toEqual([
      {parentId: 'b-1', markdown: 'final', replyKey: 'reply:b-1:1:0', shape: 'block', final: true},
    ])
  })

  it('failure with streamReply: the note collapses the streamed subtree to a single block', async () => {
    const {graph, blocks, reconciles} = fakeGraph({
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

    expect(reconciles[0].markdown).toBe('💭 Claude is working…')
    const terminal = reconciles.at(-1)!
    expect(terminal.final).toBe(true)
    expect(terminal.shape).toBe('block') // a failed run never splits
    expect(terminal.markdown).toContain('run failed')
    expect(terminal.markdown).toContain('boom')
    expect(blocks.get('b-1')?.properties?.[PROPS.status]).toBe('error')
  })

  it('failure after streaming: preserves the billed partial and appends the note (single block)', async () => {
    const {graph, blocks, reconciles} = fakeGraph({
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

    const terminal = reconciles.at(-1)!
    expect(terminal.markdown).toContain('Here is most of the answer') // partial NOT discarded
    expect(terminal.markdown).toContain('timed out')                   // note appended
    expect(terminal.shape).toBe('block')
    expect(blocks.get('b-1')?.properties?.[PROPS.status]).toBe('error')
  })

  it('transient blip on the terminal props-write does NOT post a clobbering infra note', async () => {
    const {graph, reconciles} = fakeGraph({
      backlinks: [{id: 'b-1'}],
      blocks: {'b-1': {content: '[[claude]] ok task'}},
    })
    // The reply reconcile lands fine; the blip hits the `status:done` props
    // write that FOLLOWS it. The infra-catch must not reconcile again (which
    // would overwrite the delivered answer with the infra-error note).
    const realSetTaskProps = graph.setTaskProps
    graph.setTaskProps = async (id, args) => {
      if (args.status === 'done') throw new Error('bridge command timed out')
      return realSetTaskProps(id, args)
    }
    const engine = engineWith({
      graph,
      runTask: vi.fn(async () => okRun({resultText: 'the answer'})),
      config: parseConfig({watchers: [{kind: 'backlinks', name: 'mentions', target: 'claude', quietMs: 0, splitReply: false}]}),
    })

    await engine.tick()
    await engine.drain()

    // Exactly the one terminal reconcile — no infra-error reconcile after it.
    expect(reconciles).toEqual([
      {parentId: 'b-1', markdown: 'the answer', replyKey: 'reply:b-1:1:0', shape: 'block', final: true},
    ])
  })

  it('transient blip on the terminal reply reconcile is retried and recovers the billed answer', async () => {
    const {graph, blocks, reconciles} = fakeGraph({
      backlinks: [{id: 'b-1'}],
      blocks: {'b-1': {content: '[[claude]] ok task'}},
    })
    // Reconcile is idempotent (keyed), so a transient blip on the terminal
    // write is safe to retry — the answer is recovered, not lost to error.
    const realReconcile = graph.reconcileReplyTree
    let calls = 0
    graph.reconcileReplyTree = async (parentId, markdown, opts) => {
      calls += 1
      if (calls === 1) throw new Error('bridge command timed out')
      return realReconcile(parentId, markdown, opts)
    }
    const engine = engineWith({
      graph,
      delay: async () => {},
      runTask: vi.fn(async () => okRun({resultText: 'the answer'})),
      config: parseConfig({watchers: [{kind: 'backlinks', name: 'mentions', target: 'claude', quietMs: 0, splitReply: false}]}),
    })

    await engine.tick()
    await engine.drain()

    // First attempt threw; the retry landed the answer; terminal state done.
    expect(calls).toBeGreaterThanOrEqual(2)
    expect(reconciles.at(-1)).toMatchObject({markdown: 'the answer', final: true})
    expect(blocks.get('b-1')?.properties?.[PROPS.status]).toBe('done')
  })
})

describe('splitReply (reply as a block hierarchy)', () => {
  const OUTLINE = '- Top A\n  - Child A1\n- Top B'

  it('splits the final reply (shape outline) in one terminal reconcile, and nudges the run', async () => {
    const {graph, blocks, reconciles} = fakeGraph({
      backlinks: [{id: 'b-1'}],
      blocks: {'b-1': {content: '[[claude]] reflect'}},
    })
    // mentionConfig defaults splitReply on.
    const runTask = vi.fn(async () => okRun({resultText: OUTLINE}))
    const engine = engineWith({graph, runTask})

    await engine.tick()
    await engine.drain()

    // One terminal reconcile of the reply subtree, split along the outline
    // (shape 'outline'). The app parses + reconciles the tree atomically.
    expect(reconciles).toEqual([
      {parentId: 'b-1', markdown: OUTLINE, replyKey: 'reply:b-1:1:0', shape: 'outline', final: true},
    ])
    expect(blocks.get('b-1')?.properties?.[PROPS.status]).toBe('done')

    // The run was nudged to author a nested outline (the "prompting" half).
    const prompt = (runTask.mock.calls[0][0] as {prompt: string}).prompt
    expect(prompt).toContain('block hierarchy')
  })

  it('splitReply: false keeps the single-block shape and drops the nudge', async () => {
    const {graph, reconciles} = fakeGraph({
      backlinks: [{id: 'b-1'}],
      blocks: {'b-1': {content: '[[claude]] reflect'}},
    })
    const runTask = vi.fn(async () => okRun({resultText: OUTLINE}))
    const engine = createEngine({
      config: parseConfig({
        watchers: [{kind: 'backlinks', name: 'mentions', target: 'claude', quietMs: 0, splitReply: false}],
      }),
      state: memoryState(),
      graph,
      runTask,
      deliverToChannel: vi.fn(async () => {}),
      mcpConfigPath: '/tmp/mcp.json',
      log: () => {},
      now: () => NOW,
    })

    await engine.tick()
    await engine.drain()

    expect(reconciles).toEqual([
      {parentId: 'b-1', markdown: OUTLINE, replyKey: 'reply:b-1:1:0', shape: 'block', final: true},
    ])
    const prompt = (runTask.mock.calls[0][0] as {prompt: string}).prompt
    expect(prompt).not.toContain('block hierarchy')
  })

  it('with streamReply + splitReply on: the placeholder is just the first reconcile of the same keyed subtree', async () => {
    const {graph, reconciles} = fakeGraph({
      backlinks: [{id: 'b-1'}],
      blocks: {'b-1': {content: '[[claude]] reflect'}},
    })
    const runTask = vi.fn(async () => okRun({resultText: OUTLINE}))
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
      now: () => NOW,
    })

    await engine.tick()
    await engine.drain()

    // Placeholder then the terminal split reconcile — same key + shape, so
    // the streamed placeholder block becomes the reply's first block (no
    // orphaning, no separate rootBlockId dance).
    expect(reconciles).toEqual([
      {parentId: 'b-1', markdown: '💭 Claude is working…', replyKey: 'reply:b-1:1:0', shape: 'outline', final: false},
      {parentId: 'b-1', markdown: OUTLINE, replyKey: 'reply:b-1:1:0', shape: 'outline', final: true},
    ])
  })

  it('a failed run does NOT split — the warning goes to a single block', async () => {
    const {graph, reconciles} = fakeGraph({
      backlinks: [{id: 'b-1'}],
      blocks: {'b-1': {content: '[[claude]] reflect'}},
    })
    const engine = engineWith({
      graph,
      runTask: vi.fn(async () => okRun({ok: false, exitCode: 1, stderr: 'boom', resultText: ''})),
    })

    await engine.tick()
    await engine.drain()

    expect(reconciles).toHaveLength(1)
    expect(reconciles[0].shape).toBe('block')
    expect(reconciles[0].markdown).toContain('⚠️')
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
    expect(event.meta).toEqual({watcher: 'mentions', block_id: 'b-1', attempt: '1', event_id: 'b-1:1:0'})
    expect(event.content).toContain('close the task out yourself')
    // Daemon only claims; the ambient session finishes the lifecycle.
    expect(blocks.get('b-1')?.properties?.[PROPS.status]).toBe('running')
    expect(replies).toHaveLength(0)
  })

  it('DEFERS the task when the channel listener is unreachable', async () => {
    // A listener that isn't up is infrastructure, not a bad task — and it
    // is down for every task at once, so parking them was the same
    // whole-queue kill as a credit outage.
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

    const props = blocks.get('b-1')!.properties!
    expect(props[PROPS.status]).toBe('queued')
    expect(props[PROPS.retryAfter]).toBeGreaterThan(NOW)
    expect(props[PROPS.attempts]).toBe(0)
  })

  it('posts NO retry note on a deferred channel task — nothing would ever clear it', async () => {
    // The ambient session owns a channel task's replies and posts its own
    // blocks, so a daemon-authored keyed note is never reconciled away: the
    // finished task would keep a child promising a retry that already
    // happened. The chip carries the deferral instead.
    const {graph, reconciles, replies} = fakeGraph({
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

    expect(reconciles).toEqual([])
    expect(replies).toEqual([])
  })

  it('backs off instead of re-POSTing every tick while the listener is down', async () => {
    // A query+channel failure throws to the tick's per-watcher catch, which
    // correctly leaves the cursor unadvanced — but armed nothing, so the
    // same rows went out again at every poll (5s by default) for the whole
    // outage: a retry storm exactly where the backoff was meant to apply.
    const {graph} = fakeGraph()
    graph.sqlAll = vi.fn(async () => [{id: 'a'}])
    const state = memoryState()
    state.cursors.set('inbox', [])
    let nowMs = NOW
    const time = {now: () => nowMs, advance: (ms: number) => { nowMs += ms }}
    const deliverToChannel = vi.fn(async () => { throw new Error('connection refused') })
    const engine = engineWith({
      graph, state, deliverToChannel, now: time.now,
      config: parseConfig({
        watchers: [{kind: 'query', name: 'inbox', sql: 'SELECT id FROM blocks', delivery: 'channel'}],
      }),
    })

    await engine.tick()
    await engine.drain()
    expect(deliverToChannel).toHaveBeenCalledTimes(1)

    // Three more ticks inside the backoff window deliver nothing.
    for (let round = 0; round < 3; round += 1) {
      await engine.tick()
      await engine.drain()
    }
    expect(deliverToChannel).toHaveBeenCalledTimes(1)
    // The rows are still pending — holding them, not dropping them.
    expect(state.cursors.get('inbox')).toEqual([])

    time.advance(10 * 60_000)
    await engine.tick()
    await engine.drain()
    expect(deliverToChannel).toHaveBeenCalledTimes(2)
  })

  it('reopens the channel lane once a delivery lands again', async () => {
    // The channel branch returns before the spawn success path, so nothing
    // else clears its cooldown: a recovered listener would stay throttled to
    // one delivery per backoff window forever.
    const {graph, blocks} = fakeGraph({
      backlinks: [{id: 'b-1'}, {id: 'b-2'}, {id: 'b-3'}],
      blocks: {
        'b-1': {content: '[[claude]] one'},
        'b-2': {content: '[[claude]] two'},
        'b-3': {content: '[[claude]] three'},
      },
    })
    let nowMs = NOW
    const time = {now: () => nowMs, advance: (ms: number) => { nowMs += ms }}
    let listenerDown = true
    const deliverToChannel = vi.fn(async () => {
      if (listenerDown) throw new Error('connection refused')
    })
    const engine = engineWith({
      graph, deliverToChannel, now: time.now,
      config: parseConfig({
        maxConcurrent: 1,
        runsPerHour: 100,
        watchers: [{kind: 'backlinks', name: 'ambient', target: 'claude', quietMs: 0, delivery: 'channel'}],
      }),
    })

    await engine.tick()          // b-1 fails — the channel lane cools
    await engine.drain()
    expect(blocks.get('b-1')?.properties?.[PROPS.status]).toBe('queued')

    listenerDown = false
    time.advance(10 * 60_000)    // the window lapses; one probe goes out
    await engine.tick()
    await engine.drain()

    // The probe succeeded, so the lane is open: the very next tick claims
    // again rather than waiting out another backoff window.
    await engine.tick()
    await engine.drain()
    const claimed = ['b-1', 'b-2', 'b-3'].filter(id => blocks.get(id)?.properties?.[PROPS.status] === 'running')
    expect(claimed.length).toBeGreaterThanOrEqual(2)
  })

  it('still parks a task whose failure is not an infrastructure one', async () => {
    const {graph, blocks} = fakeGraph({
      backlinks: [{id: 'b-1'}],
      blocks: {'b-1': {content: '[[claude]] ambient task'}},
    })
    const engine = engineWith({
      graph,
      deliverToChannel: vi.fn(async () => { throw new Error('channel listener rejected the event body') }),
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

describe('retryable infrastructure failures (out of credits, expired login, network)', () => {
  /** Mutable clock — these tests step past cooldowns/retry-after windows. */
  const clock = (startMs = NOW) => {
    let nowMs = startMs
    return {now: () => nowMs, advance: (ms: number) => { nowMs += ms }}
  }

  it('leaves the task PENDING instead of parking it — "we could not try" is not "it failed"', async () => {
    const {graph, blocks, propWrites, reconciles} = fakeGraph({
      backlinks: [{id: 'b-1'}],
      blocks: {'b-1': {content: '[[claude]] summarize inbox'}},
    })
    const state = memoryState()
    const time = clock()
    const engine = engineWith({graph, state, now: time.now, runTask: vi.fn(async () => outOfCreditsRun())})

    await engine.tick()
    await engine.drain()

    expect(propWrites.map(write => write.status)).toEqual(['running', 'queued'])
    const props = blocks.get('b-1')!.properties!
    // Attempts are handed BACK: they cap a task that keeps CRASHING, and
    // counting an outage against them parks the queue after three ticks.
    expect(props[PROPS.attempts]).toBe(0)
    expect(props[PROPS.error]).toContain('out of credits')
    expect(props[PROPS.retryAfter]).toBeGreaterThan(NOW)
    // A run that never reached the model billed nothing, so the hourly
    // spend budget must not be spent on it either.
    expect(state.launches).toEqual([])
    // The visible trace says "waiting", not "failed", and collapses to one
    // block so the retry's real answer converges onto it.
    expect(reconciles.at(-1)).toMatchObject({markdown: expect.stringContaining('retrying automatically'), shape: 'block'})
  })

  it('does not chew the rest of the queue into the same state', async () => {
    // The reported bug: one credit outage marked every queued task failed,
    // because the daemon kept picking work up and each pickup burned a task.
    const {graph, blocks} = fakeGraph({
      backlinks: [{id: 'b-1'}, {id: 'b-2'}, {id: 'b-3'}],
      blocks: {
        'b-1': {content: '[[claude]] one'},
        'b-2': {content: '[[claude]] two'},
        'b-3': {content: '[[claude]] three'},
      },
    })
    const time = clock()
    const runTask = vi.fn(async () => outOfCreditsRun())
    const engine = engineWith({
      graph, runTask, now: time.now,
      config: mentionConfig({maxConcurrent: 1, runsPerHour: 100}),
    })

    await engine.tick()
    await engine.drain()
    expect(runTask).toHaveBeenCalledTimes(1)

    // Cooldown: further ticks claim NOTHING, so the untouched tasks keep
    // their pristine (unclaimed) state instead of being spent one per tick.
    await engine.tick()
    await engine.drain()
    await engine.tick()
    await engine.drain()
    expect(runTask).toHaveBeenCalledTimes(1)
    expect(blocks.get('b-2')?.properties).toEqual({})
    expect(blocks.get('b-3')?.properties).toEqual({})

    // Once it lapses exactly one probe goes out — not the whole backlog.
    time.advance(30_000)
    await engine.tick()
    await engine.drain()
    expect(runTask).toHaveBeenCalledTimes(2)
  })

  it('never exhausts MAX_ATTEMPTS while the outage lasts', async () => {
    const {graph, blocks} = fakeGraph({
      backlinks: [{id: 'b-1'}],
      blocks: {'b-1': {content: '[[claude]] do the thing'}},
    })
    const time = clock()
    const runTask = vi.fn(async () => outOfCreditsRun())
    const engine = engineWith({graph, runTask, now: time.now, config: mentionConfig({runsPerHour: 100})})

    for (let round = 0; round < MAX_ATTEMPTS + 3; round += 1) {
      await engine.tick()
      await engine.drain()
      time.advance(10 * 60_000)   // past both the cooldown and retry-after
      const props = blocks.get('b-1')!.properties!
      expect(props[PROPS.status]).toBe('queued')
      // The counter itself must not creep: `queued` is re-fired without an
      // attempts check, so a task that merely never PARKS would pass while
      // silently spending its real retry budget — the next genuine crash
      // after the outage would then park it immediately.
      expect(props[PROPS.attempts]).toBe(0)
    }
    expect(runTask.mock.calls.length).toBeGreaterThan(MAX_ATTEMPTS)
  })

  it('runs the deferred task normally once the outage lifts', async () => {
    const {graph, blocks, reconciles} = fakeGraph({
      backlinks: [{id: 'b-1'}],
      blocks: {'b-1': {content: '[[claude]] summarize inbox'}},
    })
    const time = clock()
    let credits = false
    const engine = engineWith({
      graph, now: time.now,
      runTask: vi.fn(async () => credits ? okRun() : outOfCreditsRun()),
    })

    await engine.tick()
    await engine.drain()
    expect(blocks.get('b-1')?.properties?.[PROPS.status]).toBe('queued')

    credits = true
    time.advance(60_000)
    await engine.tick()
    await engine.drain()

    const props = blocks.get('b-1')!.properties!
    expect(props[PROPS.status]).toBe('done')
    expect(props[PROPS.attempts]).toBe(1)     // the deferral cost nothing
    expect(props[PROPS.retryAfter]).toBe(0)   // and the clock is cleared
    // Same reply subtree throughout: the answer REPLACES the waiting note
    // rather than stacking under it.
    expect(new Set(reconciles.map(reconcile => reconcile.replyKey))).toEqual(new Set(['reply:b-1:1:0']))
    expect(reconciles.at(-1)?.markdown).toBe('Reply text')
  })

  it('backs off further while the outage persists, and resets once a run gets through', async () => {
    const {graph, blocks} = fakeGraph({
      backlinks: [{id: 'b-1'}, {id: 'b-2'}],
      blocks: {'b-1': {content: '[[claude]] one'}, 'b-2': {content: '[[claude]] two'}},
    })
    const time = clock()
    let succeed = false
    const engine = engineWith({
      graph, now: time.now,
      runTask: vi.fn(async () => succeed ? okRun() : outOfCreditsRun()),
      config: mentionConfig({maxConcurrent: 1, runsPerHour: 100}),
    })

    await engine.tick()
    await engine.drain()
    expect(blocks.get('b-1')?.properties?.[PROPS.retryAfter]).toBe(NOW + 30_000)

    // Same task comes due, fails again — second failure in a row, so the
    // next wait is longer.
    time.advance(30_000)
    await engine.tick()
    await engine.drain()
    expect(blocks.get('b-1')?.properties?.[PROPS.retryAfter]).toBe(NOW + 30_000 + 60_000)

    // A run that reaches the model proves the infrastructure is back, so a
    // later blip starts the schedule over instead of inheriting the ramp.
    succeed = true
    time.advance(60_000)
    await engine.tick()
    await engine.drain()
    expect(blocks.get('b-1')?.properties?.[PROPS.status]).toBe('done')

    succeed = false
    const afterReset = time.now()
    await engine.tick()
    await engine.drain()
    expect(blocks.get('b-2')?.properties?.[PROPS.retryAfter]).toBe(afterReset + 30_000)
  })

  it('lets exactly ONE probe through a lapsed cooldown, at maxConcurrent > 1', async () => {
    // The cooldown gate opens for EVERY source in the scan the instant the
    // window lapses, and nothing re-arms until a run's async result lands
    // — so without a synchronous reservation the daemon fires a full
    // concurrency-worth of doomed runs at each lapse instead of one probe.
    // maxConcurrent defaults to 2, so the default config had this bug.
    const {graph} = fakeGraph({
      backlinks: [{id: 'b-1'}, {id: 'b-2'}, {id: 'b-3'}],
      blocks: {
        'b-1': {content: '[[claude]] one'},
        'b-2': {content: '[[claude]] two'},
        'b-3': {content: '[[claude]] three'},
      },
    })
    const time = clock()
    const runTask = vi.fn(async () => outOfCreditsRun())
    const engine = engineWith({
      graph, runTask, now: time.now,
      config: mentionConfig({maxConcurrent: 2, runsPerHour: 100}),
    })

    // No outage known yet, so the first tick uses its full concurrency.
    await engine.tick()
    await engine.drain()
    expect(runTask).toHaveBeenCalledTimes(2)

    time.advance(10 * 60_000)
    await engine.tick()
    await engine.drain()
    // One more, not two: the probe reserves the lane as it launches.
    expect(runTask).toHaveBeenCalledTimes(3)
  })

  it('cools down only the FAILING executor, leaving another one working', async () => {
    // A spent Claude subscription says nothing about a Codex watcher. A
    // single global window stalls it for up to five minutes.
    const {graph, blocks} = fakeGraph({
      backlinksByTarget: {claude: [{id: 'b-1'}], codex: [{id: 'c-1'}]},
      blocks: {'b-1': {content: '[[claude]] one'}, 'c-1': {content: '[[codex]] one'}},
    })
    const time = clock()
    const runTask = vi.fn(async (options: {executor?: string}) =>
      options.executor === 'codex' ? okRun() : outOfCreditsRun())
    const engine = engineWith({
      graph, runTask, now: time.now,
      config: parseConfig({
        // maxConcurrent 1 so the claude run FAILS (arming its lane) before
        // the codex watcher is ever scanned — the ordering the bug needs.
        maxConcurrent: 1,
        runsPerHour: 100,
        watchers: [
          {kind: 'backlinks', name: 'claude-mentions', target: 'claude', quietMs: 0},
          {kind: 'backlinks', name: 'codex-mentions', target: 'codex', quietMs: 0, runner: {executor: 'codex'}},
        ],
      }),
    })

    await engine.tick()
    await engine.drain()
    expect(blocks.get('b-1')?.properties?.[PROPS.status]).toBe('queued')
    expect(blocks.get('c-1')?.properties).toEqual({})

    await engine.tick()
    await engine.drain()
    expect(blocks.get('c-1')?.properties?.[PROPS.status]).toBe('done')
  })

  it('does not let a healthy executor\'s success clear the failing one\'s cooldown', async () => {
    // The worse half of a global window: the failing lane resumes chewing
    // its queue because an unrelated watcher happened to succeed.
    const {graph, blocks} = fakeGraph({
      backlinksByTarget: {claude: [{id: 'b-1'}, {id: 'b-2'}], codex: [{id: 'c-1'}]},
      blocks: {
        'b-1': {content: '[[claude]] one'},
        'b-2': {content: '[[claude]] two'},
        'c-1': {content: '[[codex]] one'},
      },
    })
    const time = clock()
    const runTask = vi.fn(async (options: {executor?: string}) =>
      options.executor === 'codex' ? okRun() : outOfCreditsRun())
    const engine = engineWith({
      graph, runTask, now: time.now,
      config: parseConfig({
        maxConcurrent: 1,
        runsPerHour: 100,
        watchers: [
          {kind: 'backlinks', name: 'claude-mentions', target: 'claude', quietMs: 0},
          {kind: 'backlinks', name: 'codex-mentions', target: 'codex', quietMs: 0, runner: {executor: 'codex'}},
        ],
      }),
    })

    await engine.tick()   // b-1 runs out of credits — the claude lane cools
    await engine.drain()
    await engine.tick()   // c-1 succeeds on the codex lane
    await engine.drain()
    expect(blocks.get('c-1')?.properties?.[PROPS.status]).toBe('done')

    await engine.tick()
    await engine.drain()
    // b-2 is untouched: the codex success proved nothing about credits.
    expect(blocks.get('b-2')?.properties).toEqual({})
  })

  it('lets an explicit user retry through the cooldown — but only one of a batch', async () => {
    // "Retry now" clears the block's durable agent:retry-after, but the
    // daemon's in-memory cooldown is the other half of the clock: without
    // a bypass the gesture silently does nothing for up to five minutes.
    // And a bulk "Retry all failed" must still probe with ONE run, not
    // fire the whole batch into an outage that may still be on.
    const {graph, blocks} = fakeGraph({
      backlinks: [{id: 'b-1'}, {id: 'b-2'}, {id: 'b-3'}],
      blocks: {
        'b-1': {content: '[[claude]] one'},
        'b-2': {content: '[[claude]] two'},
        'b-3': {content: '[[claude]] three'},
      },
    })
    const time = clock()
    const runTask = vi.fn(async () => outOfCreditsRun())
    const engine = engineWith({
      graph, runTask, now: time.now,
      config: mentionConfig({maxConcurrent: 2, runsPerHour: 100}),
    })

    await engine.tick()
    await engine.drain()
    expect(runTask).toHaveBeenCalledTimes(2)

    // What the app's Retry writes: terminal props dropped, asked-at stamped.
    time.advance(1_000)
    for (const id of ['b-1', 'b-2', 'b-3']) {
      const target = blocks.get(id)!
      target.properties = {[PROPS.askedAt]: time.now()}
      target.editedAtMs = time.now()
    }

    // Still inside the cooldown window — no clock advance past it.
    await engine.tick()
    await engine.drain()
    expect(runTask).toHaveBeenCalledTimes(3)
  })

  // A mid-stream ECONNRESET classifies as `network`, but the model was
  // reached and the tokens are spent. Deferring it would hand back the
  // attempt AND the runsPerHour slot, so a repeating disconnect could
  // re-bill the same task without limit, outside the spend cap entirely.
  // Two independent proofs the model was reached, pinned separately:
  // streamed text, and a result payload on a non-streaming watcher.
  it('parks a run that STREAMED an answer before dying, rather than replaying it', async () => {
    const {graph, blocks, propWrites, reconciles} = fakeGraph({
      backlinks: [{id: 'b-1'}],
      blocks: {'b-1': {content: '[[claude]] summarize inbox'}},
    })
    const state = memoryState()
    const runTask = vi.fn(async (options: {onEvent?: (event: {kind: string, text?: string}) => void}) => {
      options.onEvent?.({kind: 'text', text: 'Here is most of the answer'}) // billed
      return okRun({ok: false, resultText: '', sessionId: null, exitCode: 1, stderr: 'ECONNRESET', failureText: 'ECONNRESET'})
    })
    const engine = engineWith({
      graph, state, runTask,
      config: parseConfig({watchers: [{kind: 'backlinks', name: 'mentions', target: 'claude', quietMs: 0, streamReply: true}]}),
    })

    await engine.tick()
    await engine.drain()

    expect(propWrites.map(write => write.status)).toEqual(['running', 'error'])
    expect(blocks.get('b-1')!.properties![PROPS.attempts]).toBe(1)
    // The slot stays spent — this run cost real tokens.
    expect(state.launches).toHaveLength(1)
    // The billed partial survives, with the failure note appended.
    expect(reconciles.at(-1)?.markdown).toContain('Here is most of the answer')
  })

  it('counts streamed text as work done even when the watcher does not publish it', async () => {
    // streamReply defaults OFF, and it controls PUBLISHING, not observing.
    // If the engine only recorded streamed text for streaming watchers, a
    // default watcher whose run died mid-answer would look like it produced
    // nothing — and get its attempt and spend slot handed back for a run
    // that had already billed.
    const {graph, blocks, propWrites} = fakeGraph({
      backlinks: [{id: 'b-1'}],
      blocks: {'b-1': {content: '[[claude]] summarize inbox'}},
    })
    const state = memoryState()
    const runTask = vi.fn(async (options: {onEvent?: (event: {kind: string, text?: string}) => void}) => {
      options.onEvent?.({kind: 'text', text: 'Here is most of the answer'}) // billed
      return okRun({ok: false, resultText: '', sessionId: null, exitCode: 1, stderr: 'ECONNRESET', failureText: ''})
    })
    const engine = engineWith({graph, state, runTask})   // streamReply off

    await engine.tick()
    await engine.drain()

    expect(propWrites.map(write => write.status)).toEqual(['running', 'error'])
    expect(blocks.get('b-1')!.properties![PROPS.attempts]).toBe(1)
    expect(state.launches).toHaveLength(1)
  })

  it('shows the CLI\'s own error in the failure note when stderr is empty', async () => {
    // A failed claude envelope puts its cause in failureText and leaves
    // resultText empty, so a reason built only from stderr/resultText would
    // read "no output" for every one of them.
    const {graph, reconciles} = fakeGraph({
      backlinks: [{id: 'b-1'}],
      blocks: {'b-1': {content: '[[claude]] summarize inbox'}},
    })
    const engine = engineWith({
      graph,
      runTask: vi.fn(async () => okRun({
        ok: false, resultText: '', sessionId: null, exitCode: 1, stderr: '',
        failureText: 'Claude Code process exited with code 1: model refused',
      })),
    })

    await engine.tick()
    await engine.drain()

    expect(reconciles.at(-1)?.markdown).toContain('model refused')
  })

  it('parks a run that RETURNED an answer before dying (the codex shape)', async () => {
    // codex keeps assistant text in resultText on a failed run and puts its
    // structured error in failureText, so resultText alone is the evidence
    // here. (claude cannot produce this shape — a failed claude envelope
    // carries the error and leaves resultText empty; see runner.ts.)
    const {graph, blocks, propWrites} = fakeGraph({
      backlinks: [{id: 'b-1'}],
      blocks: {'b-1': {content: '[[claude]] summarize inbox'}},
    })
    const state = memoryState()
    const engine = engineWith({
      graph, state,
      runTask: vi.fn(async () => okRun({
        ok: false, resultText: 'Here is most of the answer', sessionId: null,
        exitCode: 1, stderr: 'ECONNRESET', failureText: 'ECONNRESET',
      })),
    })

    await engine.tick()
    await engine.drain()

    expect(propWrites.map(write => write.status)).toEqual(['running', 'error'])
    expect(blocks.get('b-1')!.properties![PROPS.attempts]).toBe(1)
    expect(state.launches).toHaveLength(1)
  })

  it('rolls the query cursor back when the runner REJECTS, not just when it returns a failure', async () => {
    // The spawn-mode query watcher advances its cursor BEFORE the run, and
    // has no graph-side task state to sweep. A rejecting runTask (the
    // executor binary missing from launchd's PATH — the very outage this
    // path exists for) escaped through launch()'s catch, leaving the
    // cursor advanced: those rows were dropped permanently.
    const {graph} = fakeGraph()
    graph.sqlAll = vi.fn(async () => [{id: 'a'}, {id: 'b'}])
    const state = memoryState()
    state.cursors.set('inbox', ['a'])
    const time = clock()
    const runTask = vi.fn(async () => { throw new Error('spawn claude ENOENT') })
    const engine = engineWith({
      graph, state, runTask, now: time.now,
      config: parseConfig({watchers: [{kind: 'query', name: 'inbox', sql: 'SELECT id FROM blocks'}]}),
    })

    await engine.tick()
    await engine.drain()

    expect(runTask).toHaveBeenCalledTimes(1)
    // Cursor back at its pre-launch value, so row 'b' re-fires.
    expect(state.cursors.get('inbox')).toEqual(['a'])
    // The doomed launch billed nothing, so it must not eat a spend slot.
    expect(state.launches).toEqual([])

    // And it does re-fire, once the cooldown lapses.
    time.advance(10 * 60_000)
    await engine.tick()
    await engine.drain()
    expect(runTask).toHaveBeenCalledTimes(2)
  })

  it('leaves the query cursor advanced when a retryable-looking failure still produced a reply', async () => {
    // Same "did it reach the model" test the mention path applies: rows
    // whose run produced billed output must not re-fire on the next tick.
    const {graph} = fakeGraph()
    graph.sqlAll = vi.fn(async () => [{id: 'a'}, {id: 'b'}])
    const state = memoryState()
    state.cursors.set('inbox', ['a'])
    const runTask = vi.fn(async () => okRun({
      ok: false, resultText: 'Here is most of the answer', exitCode: 1,
      stderr: 'ECONNRESET', failureText: 'ECONNRESET',
    }))
    const engine = engineWith({
      graph, state, runTask,
      config: parseConfig({watchers: [{kind: 'query', name: 'inbox', sql: 'SELECT id FROM blocks'}]}),
    })

    await engine.tick()
    await engine.drain()

    expect(state.cursors.get('inbox')).toEqual(['a', 'b'])
    expect(state.launches).toHaveLength(1)
  })

  it('leaves the query cursor advanced when the runner rejects for an UNRECOGNISED reason', async () => {
    // The other half of the same guard: an unclassifiable crash stays
    // terminal, so a prompt that kills the runner every time cannot
    // re-fire and re-bill forever.
    const {graph} = fakeGraph()
    graph.sqlAll = vi.fn(async () => [{id: 'a'}, {id: 'b'}])
    const state = memoryState()
    state.cursors.set('inbox', ['a'])
    const runTask = vi.fn(async () => { throw new Error('unparseable transcript') })
    const engine = engineWith({
      graph, state, runTask,
      config: parseConfig({watchers: [{kind: 'query', name: 'inbox', sql: 'SELECT id FROM blocks'}]}),
    })

    await engine.tick()
    await engine.drain()

    expect(state.cursors.get('inbox')).toEqual(['a', 'b'])
  })

  it('does not clobber a Retry that lands between the scan snapshot and the stop write', async () => {
    // The Stop-on-deferred branch parks off a batched `blockViews` snapshot
    // taken at the top of the scan. A "Retry now" in that window clears the
    // lifecycle props and asks for a fresh run — parking off the stale
    // snapshot would silently revert the gesture to `cancelled`.
    const {graph, blocks} = fakeGraph({
      backlinks: [{id: 'b-1'}],
      blocks: {
        'b-1': {
          content: '[[claude]] deferred task',
          properties: {[PROPS.status]: 'queued', [PROPS.retryAfter]: NOW + 60_000, [PROPS.cancel]: NOW},
        },
      },
    })
    // The re-read is where the race is observed: answer it with the state a
    // concurrent Retry would have left behind.
    const getBlock = graph.getBlock
    graph.getBlock = async id => {
      const target = blocks.get(id)
      if (target?.properties?.[PROPS.status] === 'queued') target.properties = {[PROPS.askedAt]: NOW}
      return getBlock(id)
    }
    const engine = engineWith({graph, config: mentionConfig({runsPerHour: 100})})

    await engine.tick()
    await engine.drain()

    // Not parked as cancelled — the retry stands.
    expect(blocks.get('b-1')?.properties?.[PROPS.error]).not.toBe('cancelled')
  })

  it('replaces the "retrying automatically" note when the user stops retrying', async () => {
    // Otherwise a cancelled task keeps a child block promising a retry that
    // will never come — the chip and the reply say opposite things.
    const {graph, blocks, reconciles} = fakeGraph({
      backlinks: [{id: 'b-1'}],
      blocks: {
        'b-1': {
          content: '[[claude]] deferred task',
          properties: {
            [PROPS.status]: 'queued', [PROPS.retryAfter]: NOW + 60_000,
            [PROPS.cancel]: NOW, [PROPS.attempts]: 0,
          },
        },
      },
    })
    const engine = engineWith({graph})

    await engine.tick()
    await engine.drain()

    expect(blocks.get('b-1')?.properties?.[PROPS.error]).toBe('cancelled')
    // Same key deferForRetry used: it rolled attempts back to attempt-1, so
    // the note's attempt number is the stored count plus one.
    expect(reconciles.at(-1)).toMatchObject({
      parentId: 'b-1', replyKey: 'reply:b-1:1:0', shape: 'block', final: true,
      markdown: expect.stringContaining('stopped retrying'),
    })
  })

  it('finds an explicit retry that sorts AFTER a source the cooldown blocks', async () => {
    // The cooldown decision is per-source now that an explicit retry can
    // pass one its neighbour cannot. Ending the sweep at the first blocked
    // source made "Retry now" depend on scan order — a newer pending
    // mention scanned first hid the retried task until the window lapsed.
    const {graph, blocks} = fakeGraph({
      backlinks: [{id: 'b-blocker'}, {id: 'b-retried'}],
      blocks: {
        'b-blocker': {content: '[[claude]] blocked by the cooldown'},
        'b-retried': {content: '[[claude]] explicitly retried'},
      },
    })
    const time = clock()
    const runTask = vi.fn(async () => outOfCreditsRun())
    const engine = engineWith({
      graph, runTask, now: time.now,
      config: mentionConfig({maxConcurrent: 1, runsPerHour: 100}),
    })

    await engine.tick()          // b-blocker runs out of credits, arming the lane
    await engine.drain()
    expect(runTask).toHaveBeenCalledTimes(1)

    // A fresh mention on b-blocker keeps it PENDING and scanned first, while
    // the user explicitly retries the later one.
    time.advance(1_000)
    blocks.get('b-blocker')!.properties = {}
    blocks.get('b-blocker')!.editedAtMs = time.now()
    blocks.get('b-retried')!.properties = {[PROPS.askedAt]: time.now()}
    blocks.get('b-retried')!.editedAtMs = time.now()

    await engine.tick()
    await engine.drain()

    // The explicit retry got the probe; the blocked neighbour did not.
    expect(blocks.get('b-retried')?.properties?.[PROPS.status]).toBeDefined()
    expect(blocks.get('b-blocker')?.properties).toEqual({})
  })

  it('clears the deferral reason when the retry finally succeeds', async () => {
    // agent:error is meaningful only for `error` and a deferred `queued`. A
    // merged terminal write left the outage reason on a task that had since
    // finished, so synced data said "done" and "out of credits" at once.
    const {graph, blocks} = fakeGraph({
      backlinks: [{id: 'b-1'}],
      blocks: {'b-1': {content: '[[claude]] summarize inbox'}},
    })
    const time = clock()
    let credits = false
    const engine = engineWith({
      graph, now: time.now, config: mentionConfig({runsPerHour: 100}),
      runTask: vi.fn(async () => (credits ? okRun() : outOfCreditsRun())),
    })

    await engine.tick()
    await engine.drain()
    expect(blocks.get('b-1')?.properties?.[PROPS.error]).toContain('out of credits')

    credits = true
    time.advance(10 * 60_000)
    await engine.tick()
    await engine.drain()

    expect(blocks.get('b-1')?.properties?.[PROPS.status]).toBe('done')
    expect(blocks.get('b-1')?.properties?.[PROPS.error]).toBe('')
  })

  it('an explicit Retry posts a NEW reply instead of editing the previous answer', async () => {
    // A Retry clears agent:attempts — that counter is the crash budget and
    // resetting it is the gesture's point — so the next run recomputed
    // attempt 1 and reused the FIRST run's reply key. The retry then edited
    // the earlier answer in place, and a shorter one truncated it. Losing
    // the reply a retry was meant to supersede is the outcome to prevent.
    const {graph, blocks, reconciles} = fakeGraph({
      backlinks: [{id: 'b-1'}],
      blocks: {'b-1': {content: '[[claude]] summarize inbox'}},
    })
    const time = clock()
    const engine = engineWith({
      graph, now: time.now, config: mentionConfig({runsPerHour: 100}),
      runTask: vi.fn(async () => okRun({resultText: 'first answer'})),
    })

    await engine.tick()
    await engine.drain()
    const firstKey = reconciles.at(-1)!.replyKey

    // What the app's Retry writes: terminal props dropped, asked-at stamped.
    time.advance(1_000)
    blocks.get('b-1')!.properties = {[PROPS.askedAt]: time.now()}
    blocks.get('b-1')!.editedAtMs = time.now()

    await engine.tick()
    await engine.drain()

    expect(reconciles.at(-1)!.replyKey).not.toBe(firstKey)
  })

  it('a DEFERRED retry still converges onto the note it left', async () => {
    // The other half of the same key: a deferral is the same attempt trying
    // again, so its ⏳ note must be replaced by the real answer rather than
    // sitting beside it. Nothing writes asked-at on that path.
    const {graph, reconciles} = fakeGraph({
      backlinks: [{id: 'b-1'}],
      blocks: {'b-1': {content: '[[claude]] summarize inbox'}},
    })
    const time = clock()
    let credits = false
    const engine = engineWith({
      graph, now: time.now, config: mentionConfig({runsPerHour: 100}),
      runTask: vi.fn(async () => (credits ? okRun() : outOfCreditsRun())),
    })

    await engine.tick()
    await engine.drain()
    credits = true
    time.advance(10 * 60_000)
    await engine.tick()
    await engine.drain()

    expect(new Set(reconciles.map(reconcile => reconcile.replyKey)).size).toBe(1)
    expect(reconciles.at(-1)?.markdown).toBe('Reply text')
  })

  it('gives a retried channel delivery the same event id, so the listener can drop it', async () => {
    // The listener starts the ambient session working BEFORE it acknowledges,
    // so a lost ack is indistinguishable from "never arrived" and the retry
    // would duplicate billed, write-capable agent work. A retry carrying the
    // SAME id is what lets the listener drop it (mcp.ts).
    const {graph} = fakeGraph({
      backlinks: [{id: 'b-1'}],
      blocks: {'b-1': {content: '[[claude]] ambient task'}},
    })
    const time = clock()
    let listenerDown = true
    const deliverToChannel = vi.fn(async () => {
      if (listenerDown) throw new Error('connection refused')
    })
    const engine = engineWith({
      graph, deliverToChannel, now: time.now,
      config: parseConfig({
        runsPerHour: 100,
        watchers: [{kind: 'backlinks', name: 'ambient', target: 'claude', quietMs: 0, delivery: 'channel'}],
      }),
    })

    await engine.tick()
    await engine.drain()

    listenerDown = false
    time.advance(10 * 60_000)
    await engine.tick()
    await engine.drain()

    const ids = deliverToChannel.mock.calls.map(call => (call[0] as {meta: {event_id?: string}}).meta.event_id)
    expect(ids).toHaveLength(2)
    // Asserted non-empty first: `undefined === undefined` would otherwise
    // report a missing id as a stable one.
    expect(ids[0]).toBeTruthy()
    expect(ids[0]).toBe(ids[1])   // the deferral rolls `attempt` back, so the id is stable
  })

  it('counts streamed query output as work done, so its rows are not re-fired', async () => {
    // The query callback recorded only `session` events, so it was blind to
    // the evidence the mention path relies on — and a claude run that
    // streamed a billed reply before a transport error left resultText empty.
    const {graph} = fakeGraph()
    graph.sqlAll = vi.fn(async () => [{id: 'a'}, {id: 'b'}])
    const state = memoryState()
    state.cursors.set('inbox', ['a'])
    const runTask = vi.fn(async (options: {onEvent?: (event: {kind: string, text?: string}) => void}) => {
      options.onEvent?.({kind: 'text', text: 'Here is most of the answer'})   // billed
      return okRun({ok: false, resultText: '', exitCode: 1, stderr: 'ECONNRESET', failureText: ''})
    })
    const engine = engineWith({
      graph, state, runTask,
      config: parseConfig({watchers: [{kind: 'query', name: 'inbox', sql: 'SELECT id FROM blocks'}]}),
    })

    await engine.tick()
    await engine.drain()

    expect(state.cursors.get('inbox')).toEqual(['a', 'b'])
    expect(state.launches).toHaveLength(1)
  })

  it('gives an explicitly rerun channel task a FRESH event id, so it is not dropped', async () => {
    // The listener drops an id it has already dispatched. Deriving that id
    // from `attempt` alone made a manual Retry — which clears agent:attempts —
    // reuse the first delivery's id, so the rerun was discarded as a
    // duplicate and the task sat until the 30-minute stale sweep. Same defect
    // the reply key had, in a second place; hence one shared derivation.
    const {graph, blocks} = fakeGraph({
      backlinks: [{id: 'b-1'}],
      blocks: {'b-1': {content: '[[claude]] ambient task'}},
    })
    const time = clock()
    const deliverToChannel = vi.fn(async () => {})
    const engine = engineWith({
      graph, deliverToChannel, now: time.now,
      config: parseConfig({
        runsPerHour: 100,
        watchers: [{kind: 'backlinks', name: 'ambient', target: 'claude', quietMs: 0, delivery: 'channel'}],
      }),
    })

    await engine.tick()
    await engine.drain()

    // What the app's Retry writes: terminal props dropped, asked-at stamped.
    time.advance(1_000)
    blocks.get('b-1')!.properties = {[PROPS.askedAt]: time.now()}
    blocks.get('b-1')!.editedAtMs = time.now()

    await engine.tick()
    await engine.drain()

    const ids = deliverToChannel.mock.calls.map(call => (call[0] as {meta: {event_id?: string}}).meta.event_id)
    expect(ids).toHaveLength(2)
    expect(ids[0]).toBeTruthy()
    expect(ids[1]).not.toBe(ids[0])
  })

  it('refuses to claim a deferred task whose Stop landed after the scan snapshot', async () => {
    // The tick's stop branch reads a batched snapshot; a Stop arriving after
    // it is invisible there but visible in the pre-claim re-read. Claiming
    // anyway spawns the executor and bills work the user explicitly stopped,
    // which the next sweep can only abort mid-run.
    const {graph, blocks} = fakeGraph({
      backlinks: [{id: 'b-1'}],
      blocks: {
        'b-1': {
          content: '[[claude]] deferred task',
          properties: {[PROPS.status]: 'queued', [PROPS.retryAfter]: NOW - 1_000},
        },
      },
    })
    // The Stop lands between the batched scan and the pre-claim read.
    const getBlock = graph.getBlock
    graph.getBlock = async id => {
      const target = blocks.get(id)
      if (target?.properties?.[PROPS.status] === 'queued') {
        target.properties = {...target.properties, [PROPS.cancel]: NOW}
      }
      return getBlock(id)
    }
    const runTask = vi.fn(async () => okRun())
    const engine = engineWith({graph, runTask, config: mentionConfig({runsPerHour: 100})})

    await engine.tick()
    await engine.drain()

    expect(runTask).not.toHaveBeenCalled()
  })

  it('counts a TOOL CALL as work done, even with no assistant text', async () => {
    // The model can request an MCP write with no textual preamble and then
    // hit its usage limit on the next turn. Judging by text alone read that
    // as "nothing ran" and replayed it — repeating a graph write, which is
    // worse than the double-billing the text-only test was written for.
    const {graph, blocks, propWrites} = fakeGraph({
      backlinks: [{id: 'b-1'}],
      blocks: {'b-1': {content: '[[claude]] file the inbox'}},
    })
    const state = memoryState()
    const runTask = vi.fn(async (options: {onEvent?: (event: {kind: string, label?: string}) => void}) => {
      options.onEvent?.({kind: 'activity', label: 'Updating a block'})   // an MCP write
      return outOfCreditsRun()
    })
    const engine = engineWith({graph, state, runTask})

    await engine.tick()
    await engine.drain()

    expect(propWrites.map(write => write.status)).toEqual(['running', 'error'])
    expect(blocks.get('b-1')!.properties![PROPS.attempts]).toBe(1)
    expect(state.launches).toHaveLength(1)
  })

  it('counts a tool call on a QUERY run too, so its rows are not re-fired', async () => {
    const {graph} = fakeGraph()
    graph.sqlAll = vi.fn(async () => [{id: 'a'}, {id: 'b'}])
    const state = memoryState()
    state.cursors.set('inbox', ['a'])
    const runTask = vi.fn(async (options: {onEvent?: (event: {kind: string, label?: string}) => void}) => {
      options.onEvent?.({kind: 'activity', label: 'Updating a block'})
      return outOfCreditsRun()
    })
    const engine = engineWith({
      graph, state, runTask,
      config: parseConfig({watchers: [{kind: 'query', name: 'inbox', sql: 'SELECT id FROM blocks'}]}),
    })

    await engine.tick()
    await engine.drain()

    expect(state.cursors.get('inbox')).toEqual(['a', 'b'])
    expect(state.launches).toHaveLength(1)
  })

  it('refunds and cools down when pre-claim bridge traffic fails', async () => {
    // The launch slot is charged at the decision, so a throw between there
    // and the claim used to leak it: the source stayed pending and repeated
    // every tick until runsPerHour was gone and real work was deferred for
    // an hour — by the path meant to prevent exactly that.
    const {graph} = fakeGraph({
      backlinks: [{id: 'b-1'}],
      blocks: {'b-1': {content: '[[claude]] summarize inbox'}},
    })
    graph.ancestors = vi.fn(async () => { throw new Error('Target client is not currently connected.') })
    const state = memoryState()
    const runTask = vi.fn(async () => okRun())
    const time = clock()
    const engine = engineWith({graph, state, runTask, now: time.now, config: mentionConfig({runsPerHour: 2})})

    await engine.tick()
    await engine.drain()

    expect(runTask).not.toHaveBeenCalled()
    expect(state.launches).toEqual([])          // slot handed back
    // And the lane cooled, so the next tick does not immediately repeat it.
    await engine.tick()
    await engine.drain()
    expect(graph.ancestors).toHaveBeenCalledTimes(1)
  })

  it('believes a cause the thrower stated, over what its message would say', async () => {
    // The message here matches NO classifier pattern — that is the point.
    // A delivery failure travels with its cause attached, so the engine
    // stops depending on having been taught every phrasing in advance.
    const {graph, blocks} = fakeGraph({
      backlinks: [{id: 'b-1'}],
      blocks: {'b-1': {content: '[[claude]] ambient task'}},
    })
    const deliverToChannel = vi.fn(async () => {
      throw withRunFailure('… …', {kind: 'network', retryable: true, label: 'listener is down'})
    })
    const engine = engineWith({
      graph, deliverToChannel,
      config: parseConfig({
        watchers: [{kind: 'backlinks', name: 'ambient', target: 'claude', quietMs: 0, delivery: 'channel'}],
      }),
    })

    await engine.tick()
    await engine.drain()

    // Deferred, not parked: the fallback string match would have said `task`.
    expect(blocks.get('b-1')?.properties?.[PROPS.status]).toBe('queued')
  })

  it('a genuine run failure still parks the task and does not arm a cooldown', async () => {
    const {graph, blocks} = fakeGraph({
      backlinks: [{id: 'b-1'}, {id: 'b-2'}],
      blocks: {'b-1': {content: '[[claude]] one'}, 'b-2': {content: '[[claude]] two'}},
    })
    const time = clock()
    const runTask = vi.fn(async () => okRun({ok: false, exitCode: 1, stderr: 'the tool blew up'}))
    const engine = engineWith({
      graph, runTask, now: time.now,
      config: mentionConfig({maxConcurrent: 1, runsPerHour: 100}),
    })

    await engine.tick()
    await engine.drain()
    expect(blocks.get('b-1')?.properties?.[PROPS.status]).toBe('error')

    // No cooldown: the next task launches on the very next tick.
    await engine.tick()
    await engine.drain()
    expect(runTask).toHaveBeenCalledTimes(2)
  })

  it('honors Stop on a deferred task — the automatic retry loop has an exit', async () => {
    const {graph, blocks} = fakeGraph({
      backlinks: [{id: 'b-1'}],
      blocks: {
        'b-1': {
          content: '[[claude]] one',
          properties: {
            [PROPS.status]: 'queued',
            [PROPS.retryAfter]: NOW + 300_000,
            [PROPS.cancel]: NOW,
          },
        },
      },
    })
    const runTask = vi.fn(async () => okRun())
    const engine = engineWith({graph, runTask})

    await engine.tick()
    await engine.drain()

    const props = blocks.get('b-1')!.properties!
    expect(props[PROPS.status]).toBe('error')
    expect(props[PROPS.error]).toBe('cancelled')
    expect(props[PROPS.cancel]).toBe('')
    expect(runTask).not.toHaveBeenCalled()
  })

  it('defers when the executor binary cannot be spawned at all', async () => {
    // launchd hands the daemon a different PATH than a login shell, so a
    // missing `claude` is a real way to lose an entire queue: runTask
    // THROWS, so this never becomes a run result to classify.
    const {graph, blocks} = fakeGraph({
      backlinks: [{id: 'b-1'}],
      blocks: {'b-1': {content: '[[claude]] one'}},
    })
    const engine = engineWith({
      graph,
      now: clock().now,
      runTask: vi.fn(async () => { throw new Error('spawn claude ENOENT') }),
    })

    await engine.tick()
    await engine.drain()

    const props = blocks.get('b-1')!.properties!
    expect(props[PROPS.status]).toBe('queued')
    expect(props[PROPS.error]).toContain('executor CLI could not be started')
    expect(props[PROPS.attempts]).toBe(0)
  })

  it('still parks a throw that happens AFTER the run — its answer was already billed', async () => {
    // The distinction the catch keys on: failing to START a run is free to
    // retry, failing to DELIVER a finished one is not.
    const {graph, blocks} = fakeGraph({
      backlinks: [{id: 'b-1'}],
      blocks: {'b-1': {content: '[[claude]] one'}},
    })
    // Reply reconcile fails with a network-shaped error — retryable-looking
    // text, but the answer behind it has already been paid for.
    graph.reconcileReplyTree = vi.fn(async () => { throw new Error('fetch failed: ECONNRESET') })
    const engine = engineWith({graph, now: clock().now, runTask: vi.fn(async () => okRun())})

    await engine.tick()
    await engine.drain()

    expect(blocks.get('b-1')?.properties?.[PROPS.status]).toBe('error')
  })

  it('query watcher: rolls the cursor back so the rows are not silently dropped', async () => {
    const config = parseConfig({
      watchers: [{kind: 'query', name: 'inbox', sql: 'SELECT id FROM blocks'}],
    })
    const {graph} = fakeGraph()
    graph.sqlAll = vi.fn(async () => [{id: 'a'}])
    const state = memoryState()
    state.cursors.set('inbox', [])
    const time = clock()
    let credits = false
    const runTask = vi.fn(async () => credits ? okRun() : outOfCreditsRun())
    const engine = engineWith({graph, runTask, state, config, now: time.now})

    await engine.tick()
    await engine.drain()
    // The cursor advances BEFORE the run, so an un-attempted run must put
    // it back — a query watcher has no graph-side task state to sweep.
    expect(state.cursors.get('inbox')).toEqual([])
    expect(state.launches).toEqual([])

    credits = true
    time.advance(60_000)
    await engine.tick()
    await engine.drain()
    expect(runTask).toHaveBeenCalledTimes(2)
    expect(state.cursors.get('inbox')).toEqual(['a'])
  })
})
