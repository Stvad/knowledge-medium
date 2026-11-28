/**
 * Orchestration: one `tick()` scans all watchers, claims pending work,
 * and launches bounded-concurrency agent runs. The pending/attempt
 * decisions live in watchers.ts and every side effect sits behind an
 * injected dependency, so the whole flow is testable with in-memory fakes.
 */
import {randomUUID} from 'node:crypto'
import os from 'node:os'
import { errorMessage } from '@knowledge-medium/agent-cli/client'
import { renderSubtreeOutline, type SubtreeOutlineRow } from '@knowledge-medium/agent-cli/subtreeOutline'
import type { BacklinksWatcher, DaemonConfig, QueryWatcher, Watcher } from './config.js'
import { PROPS } from './config.js'
import type { BlockData, BlockView, Graph, MemoryScope, ReplyWriter } from './graph.js'
import { formatRunUsage, THINKING_ACTIVITY, type AgentRunOptions, type AgentRunResult, type RunEvent } from './runner.js'
import { resumeOptionsForRun } from './resumeCommand.js'
import type { QueryRow } from './queryDiff.js'
import type { StateStore } from './state.js'
import { decidePending, diffQueryRows, findThreadSession, hasFreshRunningClaim, isMention, isTerminalTask, MAX_ATTEMPTS, MAX_CURSOR_IDS, retryRequestedAt, taskAttempts } from './watchers.js'
import { DEFAULT_MENTION_CHANNEL_PROMPT, renderMentionPrompt, renderQueryPrompt, renderRowTaskPrompt } from './prompt.js'
import { loadThreadContext } from './threadContext.js'
import { diffMemory, renderMemoryChanges, type MemoryEntry } from './memory.js'
import { MEMORY_DIFF_LIMIT } from './graph.js'
// Dispatch's km server (`./mcp.ts`) must never set `localMediaFiles`: this list pre-approves its add_media.
import { KM_MCP_ALLOWED_TOOLS_WITHOUT_LOCAL_FILES as DISPATCH_MCP_ALLOWED_TOOLS } from '@knowledge-medium/agent-cli/mcpShared'

type BlockTask =
  | {kind: 'mention', id: string, watcher: BacklinksWatcher, deepLink: string, baselineMs: number}
  | {kind: 'row', id: string, watcher: QueryWatcher, row: QueryRow, baselineMs: number}

// A renamed watcher leaves claims under its former name for explicit recovery.
const belongsToWatcher = (block: BlockView, watcher: Watcher) => {
  const props = block.properties
  return !props?.[PROPS.status] || !props[PROPS.watcher] || props[PROPS.watcher] === watcher.name
}

const rowTaskAction = (block: BlockView, watcher: QueryWatcher, createdSinceMs: number): 'run' | 'release' | 'skip' => {
  const props = block.properties ?? {}
  const status = props[PROPS.status]
  if (Object.hasOwn(props, PROPS.askedAt)) {
    return status && props[PROPS.watcher] === watcher.name ? 'release' : 'skip'
  }
  if (!belongsToWatcher(block, watcher) || isTerminalTask(block)) return 'skip'
  const claimed = status === 'running' || (status === 'queued' && taskAttempts(block) > 0)
  return claimed || (block.createdAt ?? -Infinity) >= createdSinceMs ? 'run' : 'skip'
}

const postsReply = (task: BlockTask) => task.kind === 'mention' || task.watcher.reply

export interface ChannelEvent {
  content: string
  meta: Record<string, string>
}

export interface EngineDeps {
  config: DaemonConfig
  /** Reads and the unattributed `agent:*` bookkeeping on source blocks. */
  graph: Graph
  /** The run's replies, the only writes attributed to the agent. */
  replies: ReplyWriter
  state: StateStore
  runTask: (options: AgentRunOptions) => Promise<AgentRunResult>
  /** EXPERIMENTAL: push an event into the ambient channel session
   *  (delivery: 'channel' watchers). Throws if unreachable. */
  deliverToChannel: (event: ChannelEvent) => Promise<void>
  /** Generated --mcp-config path and the server names allowed in Claude events. Null disables graph tools. */
  mcpConfig: NonNullable<AgentRunOptions['mcpConfig']> | null
  log: (message: string) => void
  now?: () => number
  /** Sleep between terminal reply-reconcile retries — injected so tests run
   *  instantly (default is a real timer). */
  delay?: (ms: number) => Promise<void>
}

const usageNote = (result: AgentRunResult): string =>
  result.usage ? ` · ${formatRunUsage(result.usage)}` : ''

const truncate = (value: string, max = 500): string =>
  value.length > max ? `${value.slice(0, max)}…` : value

/** True for a character safe to write into a plain-text log line — i.e.
 *  not an ASCII/C1 control byte: C0 (0x00–0x1F), DEL (0x7F) and C1
 *  (0x80–0x9F) are excluded, since their ANSI/OSC escape sequences could
 *  clear or spoof a terminal tailing the daemon log. */
const isLoggable = (ch: string): boolean => {
  const code = ch.codePointAt(0) ?? 0
  return code > 0x1f && code !== 0x7f && !(code >= 0x80 && code <= 0x9f)
}

/** One-line, bounded, log-safe quote of a block's text for the daemon
 *  log, so a claimed block is identifiable at a glance (a bare id isn't).
 *  Content can be synced or imported from an external source, so it is
 *  collapsed to one line, stripped of control bytes ({@link isLoggable})
 *  and JSON-encoded, leaving an embedded quote or backslash unambiguous. */
const logPreview = (content: string | null | undefined): string => {
  const cleaned = [...(content ?? '').replace(/\s+/g, ' ')]
    .filter(isLoggable)
    .join('')
    .trim()
  return cleaned ? JSON.stringify(truncate(cleaned, 100)) : '(empty)'
}

/** Backoff schedule for retrying the terminal reply reconcile past a
 *  transient bridge blip — recovering the billed answer instead of losing
 *  it to `status:error`. Bounded and short so a genuinely-down bridge fails
 *  fast; retrying is safe because the reconcile is keyed (reconcileReply). */
const DELIVER_RETRY_DELAYS_MS = [200, 500, 1000] as const
const THINKING_DEBOUNCE_MS = 3_000
const STREAM_REPLY_INTERVAL_MS = 1_500

/** agent:session values are executor-scoped: codex thread ids are stored
 *  as `codex:<id>`, claude session ids bare (anything stored before
 *  executors existed is a claude one). A follow-up under the OTHER executor
 *  starts a fresh thread instead of forwarding the foreign id to resume,
 *  which fails the run outright (`codex exec resume` only accepts codex
 *  thread ids, and vice versa). */
const CODEX_SESSION_PREFIX = 'codex:'

/** A resume id is forwarded verbatim as a bare argv token (`--resume <id>`
 *  / `codex exec resume <id>`), and `agent:session` is a plain block
 *  property that any MCP `update_block` caller — including a
 *  prompt-injected run — can write. A planted value like
 *  `codex:-c=tools.web_search="live"` would de-prefix to a `-c` flag and
 *  inject live codex config on the next follow-up. Real session/thread
 *  ids are UUID/token-shaped, so anything with a leading dash or a
 *  non-`[A-Za-z0-9_-]` char is rejected (→ fresh thread) before it can
 *  reach argv. */
const SESSION_ID_SHAPE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,199}$/

const storedSessionFor = (executor: 'claude' | 'codex', sessionId: string | null): string | null =>
  sessionId && executor === 'codex' ? `${CODEX_SESSION_PREFIX}${sessionId}` : sessionId

/** `agent:activity` on a follow-up queued behind its thread's live run. */
export const THREAD_BUSY_ACTIVITY = 'waiting for the run already going in this thread'

const executorLabel = (executor: 'claude' | 'codex'): string =>
  executor === 'codex' ? 'Codex' : 'Claude'

const resumableSessionFor = (executor: 'claude' | 'codex', stored: string | null): string | null => {
  if (!stored) return null
  const isCodexSession = stored.startsWith(CODEX_SESSION_PREFIX)
  const bare = executor === 'codex'
    ? (isCodexSession ? stored.slice(CODEX_SESSION_PREFIX.length) : null)
    : (isCodexSession ? null : stored)
  if (bare === null || !SESSION_ID_SHAPE.test(bare)) return null
  return bare
}

export const createEngine = (deps: EngineDeps) => {
  const {config, graph, replies, state, runTask, deliverToChannel, mcpConfig, log} = deps
  const now = deps.now ?? Date.now
  const delay = deps.delay ?? ((ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms)))

  /** Live work, keyed by block id / query-watcher key / thread session.
   *  One structure serves the double-claim guard, the capacity gate and
   *  drain(). A `session:` key is a thread-dedup placeholder rather than a
   *  run, so it is not a launch. */
  const running = new Map<string, Promise<void>>()
  /** Abort handle per in-flight mention run, keyed by source block id, so
   *  a cancel request (agent:cancel) can kill THAT run — and only it. */
  const abortControllers = new Map<string, AbortController>()
  /** target alias → {id, resolvedAt}. TTL'd: a page deleted-then-
   *  recreated gets a NEW id, and a stale id doesn't error (backlinks of
   *  a missing target just return []), so an unbounded cache would
   *  silently poll a dead id forever. */
  const pageIdCache = new Map<string, {id: string, resolvedAt: number}>()
  const PAGE_ID_TTL_MS = 10 * 60_000
  const targetPageId = async (target: string): Promise<string> => {
    const cached = pageIdCache.get(target)
    if (cached && now() - cached.resolvedAt < PAGE_ID_TTL_MS) return cached.id
    const id = await graph.resolvePageId(target)
    pageIdCache.set(target, {id, resolvedAt: now()})
    return id
  }
  /** Launch timestamps within the rolling hour — the global spend
   *  circuit-breaker. PERSISTED (state.ts): an in-memory-only log would
   *  re-arm a full budget on every crash/restart, unbounding the exact
   *  trigger-loop the cap exists to stop. Seeded from disk on first tick. */
  let launchTimes: number[] = []
  let launchTimesLoaded = false

  // Excluded so one --resume follow-up doesn't consume two of
  // maxConcurrent's slots.
  const activeRuns = () => {
    let count = 0
    for (const key of running.keys()) if (!key.startsWith('session:')) count += 1
    return count
  }
  const capacityLeft = () => config.maxConcurrent - activeRuns()

  const pruneLaunchTimes = () => {
    const cutoff = now() - 60 * 60_000
    while (launchTimes.length > 0 && launchTimes[0] < cutoff) launchTimes.shift()
  }

  const spendBudgetLeft = (): boolean => {
    pruneLaunchTimes()
    return launchTimes.length < config.runsPerHour
  }

  const persistLaunchTimes = () => {
    // Fire-and-forget: the in-memory log already gates this tick; the
    // write only needs to survive a later restart. Pass a COPY — the
    // live array keeps mutating (prune/push) while the async write runs.
    void state.setLaunchTimes([...launchTimes]).catch(error =>
      log(`failed to persist spend log: ${errorMessage(error)}`))
  }

  const recordLaunch = (): number => {
    const stamp = now()
    launchTimes.push(stamp)
    pruneLaunchTimes()
    persistLaunchTimes()
    return stamp
  }

  /** Give back a slot recorded at the launch decision when the task
   *  provably spawned nothing (duplicate session, lost claim, block
   *  gone) — otherwise a tight runsPerHour defers REAL work for an
   *  hour on phantom launches. */
  const refundLaunch = (stamp: number) => {
    const index = launchTimes.indexOf(stamp)
    if (index === -1) return // already pruned out of the window
    launchTimes.splice(index, 1)
    persistLaunchTimes()
  }

  // INVARIANT: callers must guarantee `key` is unique among LIVE launches.
  // The .finally below deletes the key unconditionally, so two live promises
  // sharing one key would evict each other from `running`, breaking
  // drain()/capacity accounting for the survivor.
  const launch = (key: string, work: () => Promise<void>) => {
    const promise = work()
      .catch(error => log(`[${key}] run crashed: ${errorMessage(error)}`))
      .finally(() => running.delete(key))
    running.set(key, promise)
  }

  const runOptionsFor = (
    watcher: Watcher, prompt: string, resumeSessionId?: string, onEvent?: (event: RunEvent) => void,
    signal?: AbortSignal,
  ): AgentRunOptions => {
    const {runner} = watcher
    return {
      claudeBin: config.claudeBin,
      prompt,
      cwd: runner.cwd ?? os.homedir(),
      allowedTools: runner.executor === 'claude'
        ? [...new Set([
          ...(mcpConfig ? DISPATCH_MCP_ALLOWED_TOOLS : []),
          ...config.defaultAllowedTools,
          ...runner.allowedTools,
        ])]
        : [],
      allowedPlugins: runner.executor === 'claude' ? runner.allowedPlugins : undefined,
      mcpConfig: mcpConfig ?? undefined,
      model: runner.model,
      effort: runner.executor === 'claude' ? runner.effort : undefined,
      resumeSessionId,
      timeoutMs: runner.timeoutMs,
      onEvent,
      executor: runner.executor,
      codexSandbox: runner.executor === 'codex' ? runner.sandbox : undefined,
      codexAddDirs: runner.executor === 'codex' ? runner.addDirs : undefined,
      codexNetworkAccess: runner.executor === 'codex' ? runner.networkAccess : undefined,
      codexApprovalPolicy: runner.executor === 'codex' ? runner.approvalPolicy : undefined,
      codexApprovalsReviewer: runner.executor === 'codex' ? runner.approvalsReviewer : undefined,
      billing: config.billing,
      signal,
    }
  }

  const currentTaskBlock = async (task: BlockTask) => {
    const {watcher, id} = task
    const block = await graph.getBlock(id)
    if (!block || !belongsToWatcher(block, watcher)) return null
    // Defence in depth: an older app can resolve a literal row id as a reference despite exactIds.
    if (task.kind === 'row' && (block.id !== id || block.workspaceId !== config.workspaceId)) {
      log(`[${watcher.name}] skipped ${id}: block no longer matches the row in the configured workspace`)
      return null
    }
    return block
  }

  const pendingDecision = (task: BlockTask, source: BlockView, editingActiveAtMs?: number) => {
    const status = source.properties?.[PROPS.status]
    if (task.kind === 'row' && rowTaskAction(source, task.watcher, task.baselineMs) !== 'run') {
      return {pending: false, reason: 'ineligible-row'} as const
    }
    if (source.properties?.[PROPS.cancel] && (status === 'running' || status === 'queued')) {
      if (task.watcher.delivery === 'spawn') return {pending: false, reason: 'cancelled'} as const
      if (status === 'running') return {pending: false, reason: 'clear-cancel'} as const
    }
    return decidePending({
      source, nowMs: now(), editingActiveAtMs,
      settleMs: task.watcher.settleMs, editHoldMs: task.watcher.editHoldMs,
      baselineMs: task.kind === 'mention' ? task.baselineMs : undefined,
    })
  }

  /** Recheck the reason before parking. Write terminal props before a reply
   *  so a failed reply cannot retrigger this unbilled write every tick. */
  const parkTask = async (task: BlockTask, expected: 'attempts-exhausted' | 'cancelled') => {
    const {watcher, id: sourceId} = task
    const fresh = await currentTaskBlock(task)
    if (!fresh || pendingDecision(task, fresh).reason !== expected) return
    const reason = expected === 'cancelled' ? 'cancelled'
      : `gave up after ${MAX_ATTEMPTS} attempts (runs kept crashing or the channel session never closed the task)`
    await graph.setTaskProps(sourceId, {status: 'error', error: reason, cancel: null, activity: null, nowMs: now()})
    if (postsReply(task)) await replies.reconcileReplyTree(sourceId, `⚠️ agent-dispatch: ${reason}.`, {
      replyKey: `park:${sourceId}:${randomUUID()}`, shape: 'block', final: true,
    }).catch(() => {})
    log(`[${watcher.name}] parked ${sourceId}: ${reason}`)
  }

  /** The watcher's memory as the run starts: what its prompt shows, and the
   *  entries the reply's account of memory changes is diffed against. The
   *  shared notes are fixed here, so an embed the run adds or removes is
   *  reported as that one note rather than as the notes it shows appearing
   *  or going; an edit through an embed the run added goes unlisted. */
  const loadMemory = async (watcher: BacklinksWatcher, mentionId: string) => {
    const blockId = await graph.ensureMemoryBlock(await targetPageId(watcher.target))
    const outline = await graph.memoryOutline(blockId)
    const scope: MemoryScope = {memoryId: blockId, sharedRoots: outline.sharedRoots, mentionId}
    return {blockId, outline: outline.text, scope, entries: await graph.memoryEntries(scope)}
  }

  /** What the run changed in its memory, for the reply; null when nothing. */
  const memoryChanges = async (
    watcher: Watcher, memory: {blockId: string, scope: MemoryScope, entries: MemoryEntry[] | null},
  ): Promise<string | null> => {
    try {
      const after = await graph.memoryEntries(memory.scope)
      if (!memory.entries || !after) {
        return `Memory and the shared notes it embeds have more than ${MEMORY_DIFF_LIMIT} blocks, so changes to them are not listed here.`
      }
      return renderMemoryChanges(diffMemory(memory.entries, after))
    } catch (error) {
      log(`[${watcher.name}] could not read memory ${memory.blockId} after the run: ${errorMessage(error)}`)
      return null
    }
  }

  const preparePrompt = async (task: BlockTask, block: BlockData, ancestorBlocks: BlockData[]) => {
    const sourceId = task.id
    const subtreeRows = await graph.getSubtree(sourceId)
    const subtree = renderSubtreeOutline(subtreeRows as SubtreeOutlineRow[], {includeProperties: true})
    if (task.kind === 'row') {
      const prompt = renderRowTaskPrompt(task.watcher.prompt, {
        row: task.row, subtree, blockId: sourceId, watcherName: task.watcher.name,
      })
      return {prompt, memory: null}
    }
    const {watcher} = task
    // Context only: a thread that can't be read (an app without the
    // comments verb, the plugin off) leaves the mention answered without it.
    const thread = await loadThreadContext(graph, block, ancestorBlocks).catch(error => {
      log(`[${watcher.name}] no thread context for ${sourceId}: ${errorMessage(error)}`)
      return null
    })
    const memory = watcher.memory
      ? await loadMemory(watcher, sourceId).catch(error => {
        log(`[${watcher.name}] no memory for ${sourceId}: ${errorMessage(error)}`)
        return null
      })
      : null
    const defaultTemplate = watcher.delivery === 'channel' ? DEFAULT_MENTION_CHANNEL_PROMPT : undefined
    const prompt = renderMentionPrompt(watcher.prompt ?? defaultTemplate, {
      content: block.content ?? '',
      subtree,
      // graph.ancestors is nearest-first; the prompt reads root→leaf.
      ancestors: ancestorBlocks.map(ancestor => ({id: ancestor.id, content: ancestor.content ?? ''})).reverse(),
      blockId: sourceId,
      deepLink: task.deepLink,
      watcherName: watcher.name,
      target: watcher.target,
      thread: thread ?? undefined,
      memory: memory ? {blockId: memory.blockId, outline: memory.outline, shared: memory.scope.sharedRoots.length > 0} : undefined,
      // Only spawn delivery posts (and thus splits) the reply — the
      // channel session writes its own, so don't nudge it.
      splitReply: watcher.delivery !== 'channel' && watcher.splitReply,
    })
    return {prompt, memory}
  }

  /** The pre-claim re-check; null when the mention is no longer pending. */
  const readPendingTask = async (task: BlockTask) => {
    const sourceId = task.id
    // Edit state first: a block read after "not being edited" can't be older
    // than the edit that ended, and the prompt is built from this read.
    const editingActiveAtMs = (await graph.beingEditedBlocks()).get(sourceId)
    const block = await currentTaskBlock(task)
    if (!block) return null
    const decision = pendingDecision(task, block, editingActiveAtMs)
    if (!decision.pending) return null
    return {block, decision, ancestorBlocks: task.kind === 'row' ? [] : await graph.ancestors(sourceId)}
  }

  const processBlockTask = async (task: BlockTask, launchStamp: number) => {
    const {watcher, id: sourceId} = task
    const streamReply = task.kind === 'mention' && task.watcher.streamReply
    const {runner} = watcher
    // Pre-claim exits spawned nothing, so each one, a failed read included,
    // gives the launch slot back.
    const pending = await readPendingTask(task)
      .catch(error => {
        refundLaunch(launchStamp)
        throw error
      })
    if (!pending) return refundLaunch(launchStamp)
    const {block, decision, ancestorBlocks} = pending
    const acceptedRetry = retryRequestedAt(block) > 0 ? {retryAt: 0, cancel: null} : {}

    // Resolve the thread session BEFORE claiming so two follow-ups in
    // one thread can't run `--resume <same session>` concurrently.
    const session = task.kind === 'mention' && task.watcher.resume
      ? resumableSessionFor(runner.executor, findThreadSession(block, ancestorBlocks))
      : null
    const sessionKey = session ? `session:${session}` : null
    if (sessionKey && running.has(sessionKey)) {
      refundLaunch(launchStamp)
      if (block.properties?.[PROPS.status] === 'queued') return
      log(`[${watcher.name}] ${sourceId} waiting: its thread's session ${session} is still running`)
      await graph.setTaskProps(sourceId, {
        status: 'queued', watcher: watcher.name, executor: runner.executor, activity: THREAD_BUSY_ACTIVITY, nowMs: now(),
        ...acceptedRetry,
      })
      return
    }
    if (sessionKey) running.set(sessionKey, Promise.resolve())

    // A fresh run's session id is unknown until mid-run. The instant it is
    // written to the block, findThreadSession resolves it for a follow-up
    // nested under this source — so a live session must ALSO hold a dedup
    // key, or that follow-up would pass the guard above and `--resume` the
    // SAME session concurrently. Registered when the session event arrives
    // (below), released in finally; null until a resumable session shows up.
    let liveSessionKey: string | null = null

    // Progress-write chain — hoisted so the infra-catch below can drain it
    // first, so a queued streamed reconcile never lands AFTER (and clobbers)
    // the note.
    let writes: Promise<unknown> = Promise.resolve()
    // A failed run includes the latest text received from the runner, even
    // if that text was still buffered when the run ended.
    let lastStreamedText = ''
    // Set once a TERMINAL reply (the ok answer, or the failure/partial note)
    // has been written. The infra-catch checks it so a transient blip on the
    // *terminal props write* — which lands AFTER a good reply — can't
    // re-enter the reply write and clobber the answer.
    let terminalReplyDelivered = false
    const attempt = taskAttempts(block) + 1
    // Ask Agent can reset a mention's attempt count while its earlier reply keys remain.
    const replyKey = task.kind === 'row' ? `row-reply:${sourceId}:${attempt}` : `reply:${sourceId}:${attempt}:${randomUUID()}`
    const replyShape = task.kind === 'row' || task.watcher.splitReply ? 'outline' : 'block'
    // Abort handle for THIS run — a cancel request (agent:cancel, detected
    // in the tick) aborts it, killing the child. `signal.aborted` after the
    // run tells a user cancel apart from a timeout/crash.
    const abortController = new AbortController()

    // The reply is a keyed block subtree the app reconciles to match
    // `markdown`: every write tagged with this run's `replyKey` converges
    // the SAME subtree in place, so streaming is just repeated reconciles
    // with the growing text (the last passes `final`) and any write can be
    // re-sent without duplicating. A rerun uses a fresh key, so it posts a
    // fresh reply instead of mutating the prior attempt's answer.
    // `shape:'outline'` splits the reply into a block hierarchy, `'block'`
    // keeps it whole.
    const reconcileReply = async (
      markdown: string,
      {final = false, shape = replyShape}: {final?: boolean, shape?: 'outline' | 'block'} = {},
    ): Promise<void> => {
      if (postsReply(task)) await replies.reconcileReplyTree(sourceId, markdown, {replyKey, shape, final})
    }
    const writeWithRetry = async (label: string, write: () => Promise<void>): Promise<void> => {
      for (let attempt = 0; ; attempt += 1) {
        try {
          await write()
          return
        } catch (error) {
          if (attempt >= DELIVER_RETRY_DELAYS_MS.length) throw error
          log(`[${watcher.name}] retrying ${label} write for ${sourceId} after a transient error: ${errorMessage(error)}`)
          await delay(DELIVER_RETRY_DELAYS_MS[attempt])
        }
      }
    }

    let claimed = false
    let runSucceeded = false
    const failureProps = () => !runSucceeded && task.kind === 'row' && attempt < MAX_ATTEMPTS && !abortController.signal.aborted
      ? {status: 'queued' as const, attempts: attempt} : {status: 'error' as const, attempts: attempt, cancel: null}
    try {
      const claimStamp = now()
      log(`[${watcher.name}] claiming ${sourceId} ${logPreview(block.content)} (${decision.reason}, attempt ${attempt})`)
      await graph.setTaskProps(sourceId, {
        status: 'running', watcher: watcher.name, executor: runner.executor, attempts: attempt, activity: null, error: null, nowMs: claimStamp,
        ...acceptedRetry,
      })

      claimed = true

      // Claim-verify: re-read and confirm OUR claim stuck. Defends only
      // against a faster LOCAL overwrite (two daemons on one client); it
      // does NOT make cross-machine safe, since each daemon reads its own
      // client and two machines both see their own write and proceed.
      // Cross-machine safety rests on one-daemon-per-fleet (README) + the
      // pidfile.
      const verified = await graph.getBlock(sourceId)
      const props = verified?.properties ?? {}
      if (props[PROPS.watcher] !== watcher.name || props[PROPS.updatedAt] !== claimStamp) {
        log(`[${watcher.name}] lost claim race on ${sourceId} — backing off`)
        refundLaunch(launchStamp)
        return
      }

      // Register the abort handle NOW, not just before the run: a Stop can
      // land during getSubtree / prompt render / the streamReply write, and
      // the sweep can only abort a run whose controller it can see. Aborting
      // before the child spawns makes runTask start already-cancelled
      // (execProcess skips the spawn) and park `error: cancelled`. Inside
      // the try so the finally always clears it.
      abortControllers.set(sourceId, abortController)

      const {prompt, memory} = await preparePrompt(task, block, ancestorBlocks)

      if (watcher.delivery === 'channel') {
        // A Stop during the reads above: once delivered, the channel session
        // has the task and nothing aborts it.
        if (abortController.signal.aborted) {
          await reconcileReply('⏹️ agent-dispatch run cancelled', {final: true, shape: 'block'})
          terminalReplyDelivered = true
          await graph.setTaskProps(sourceId, {status: 'error', error: 'cancelled', activity: null, cancel: null, nowMs: now()})
          log(`[${watcher.name}] CANCELLED ${sourceId} before delivery`)
          return
        }
        // Ambient mode: deliver and step back — the channel session owns
        // the rest of the lifecycle (reply block + done/error props). If
        // it never does, the stale-running sweep re-delivers, bounded by
        // MAX_ATTEMPTS.
        await deliverToChannel({
          content: prompt,
          meta: {watcher: watcher.name, block_id: sourceId, attempt: String(attempt)},
        })
        log(`[${watcher.name}] delivered ${sourceId} to the ambient channel session (attempt ${attempt})`)
        return
      }

      // streamReply: post an immediate placeholder so the reply appears at
      // once; the first streamed tick reconciles it into real content.
      // Best-effort — a cosmetic spinner must not fail the run.
      if (streamReply) {
        await reconcileReply(`💭 ${executorLabel(runner.executor)} is working…`).catch(() => {})
      }

      // All progress-driven graph writes funnel through one promise
      // chain (hoisted above) so they can never reorder relative to
      // each other (or to the final writes below, which drain it first).
      let writeErrorLogged = false
      const queueWrite = (work: () => Promise<unknown>) => {
        writes = writes.then(work).catch(error => {
          if (!writeErrorLogged) {
            writeErrorLogged = true
            log(`[${watcher.name}] progress write failed for ${sourceId}: ${errorMessage(error)}`)
          }
        })
      }

      type Step = {label: string, startedAt: number}
      const seenSteps = new Set<string>()
      const pendingSteps = new Map<string, Step>()
      const oldestPendingStep = () => pendingSteps.values().next().value
      const writeActivity = (step: Step) => queueWrite(() => graph.setActivity(sourceId, step.label, step.startedAt))
      let thinkingTimer: ReturnType<typeof setTimeout> | undefined
      const cancelThinking = () => clearTimeout(thinkingTimer)
      let streamReplyTimer: ReturnType<typeof setTimeout> | undefined
      let sessionRecorded = false
      const resumeOptionsForSession = (sessionId: string | null) =>
        sessionId
          ? resumeOptionsForRun(runOptionsFor(watcher, prompt, sessionId, undefined, abortController.signal))
          : null
      const onEvent = (event: RunEvent) => {
        if (event.kind === 'activity') {
          if (seenSteps.has(event.stepId)) return
          seenSteps.add(event.stepId)
          cancelThinking()
          const step = {label: event.label, startedAt: now()}
          pendingSteps.set(event.stepId, step)
          if (oldestPendingStep() === step) writeActivity(step)
        } else if (event.kind === 'activity-end') {
          const previous = oldestPendingStep()
          pendingSteps.delete(event.stepId)
          const next = oldestPendingStep()
          if (next === previous) return
          if (next) {
            writeActivity(next)
          } else {
            const endedAt = now()
            thinkingTimer = setTimeout(() => writeActivity({label: THINKING_ACTIVITY, startedAt: endedAt}), THINKING_DEBOUNCE_MS)
          }
        } else if (event.kind === 'text') {
          if (!streamReply) return
          lastStreamedText = event.text
          if (streamReplyTimer !== undefined) return
          // Flush even if the runner goes quiet while a tool is running.
          streamReplyTimer = setTimeout(() => {
            streamReplyTimer = undefined
            const text = lastStreamedText
            queueWrite(() => reconcileReply(text))
          }, STREAM_REPLY_INTERVAL_MS)
        } else if (event.kind === 'session') {
          // Persist the session id the moment it arrives (the runner emits
          // it on the first init line), NOT only at the terminal write —
          // so a run that hangs, times out, or crashes still leaves a
          // resumable + inspectable session on the block. Written once;
          // the terminal write re-affirms the same value.
          if (sessionRecorded) return
          sessionRecorded = true
          const stored = storedSessionFor(runner.executor, event.sessionId)
          if (!stored) return
          const resumeOptions = resumeOptionsForSession(event.sessionId)
          // Claim the dedup key for the now-live session BEFORE exposing it
          // on the block (the register is synchronous; the block write is
          // only queued), so a follow-up can never observe the session
          // without also seeing the guard. Skip when this key is already
          // held — finally only deletes what we set.
          const resumable = resumableSessionFor(runner.executor, stored)
          const liveKey = resumable ? `session:${resumable}` : null
          if (liveKey && liveKey !== sessionKey && !running.has(liveKey)) {
            liveSessionKey = liveKey
            running.set(liveKey, Promise.resolve())
          }
          log(`[${watcher.name}] session ${stored} for ${sourceId}`)
          queueWrite(() => graph.setSession(sourceId, stored, resumeOptions))
        }
      }

      const runOptions = runOptionsFor(watcher, prompt, session ?? undefined, onEvent, abortController.signal)
      let result: AgentRunResult
      try {
        result = await runTask(runOptions)
        runSucceeded = result.ok
      } finally {
        cancelThinking()
        clearTimeout(streamReplyTimer)
      }
      await writes // ordering guarantee: no progress write races the final one below
      // On every terminal reply, a failed or cancelled run's too: it may have
      // written its memory before it ended.
      const memoryNote = memory ? await memoryChanges(watcher, memory) : null
      const withMemoryNote = (text: string) => memoryNote ? `${text}\n\n${memoryNote}` : text

      if (result.ok) {
        // Deliberately NOT gated on signal.aborted: if the child completed
        // cleanly in the same instant a Stop landed (exit 0 raced SIGTERM),
        // the billed answer is real — keep it as `done` rather than discard
        // it as `cancelled`. Only a run that ended WITHOUT a result (the
        // error branch below) inspects signal.aborted to label the reason.
        const finalText = result.resultText.trim() || `(${runner.executor} returned an empty reply)`
        // Terminal write: converges a streamed tree onto the final text, or
        // creates it fresh. Retried so a transient bridge blip recovers
        // rather than losing the billed answer.
        await writeWithRetry('reply', () => reconcileReply(withMemoryNote(finalText), {final: true}))
        terminalReplyDelivered = true
        await writeWithRetry('status', () => graph.setTaskProps(sourceId, {
          status: 'done',
          session: storedSessionFor(runner.executor, result.sessionId),
          resumeOptions: resumeOptionsForSession(result.sessionId),
          activity: null,
          cancel: null,
          nowMs: now(),
        }))
        log(`[${watcher.name}] done ${sourceId}${result.sessionId ? ` (session ${result.sessionId})` : ''}${usageNote(result)}`)
      } else {
        // A user Stop aborts the run — signal.aborted distinguishes it from
        // a timeout/crash so the task parks `error: cancelled` (deliberate,
        // terminal, non-refiring) rather than looking like a failure.
        const cancelled = abortController.signal.aborted
        const reason = cancelled
          ? 'cancelled'
          : result.timedOut
            ? `timed out after ${Math.round(runner.timeoutMs / 1000)}s`
            : `exit ${result.exitCode}: ${truncate(result.stderr.trim() || result.resultText.trim() || 'no output')}`
        const failureNote = cancelled
          ? '⏹️ agent-dispatch run cancelled'
          : `⚠️ agent-dispatch run failed — ${reason}`
        // A failed run never splits — collapse to a single block, keyed like
        // the success write so a retry recovers it in place. A run that died
        // after streaming most of its billed answer keeps that text with the
        // note appended, rather than losing it.
        const partial = lastStreamedText.trim()
        await writeWithRetry('reply', () => reconcileReply(
          withMemoryNote(partial ? `${partial}\n\n${failureNote}` : failureNote),
          {final: true, shape: 'block'},
        ))
        terminalReplyDelivered = true
        await writeWithRetry('status', () => graph.setTaskProps(sourceId, {
          ...failureProps(),
          error: reason,
          session: storedSessionFor(runner.executor, result.sessionId),
          resumeOptions: resumeOptionsForSession(result.sessionId),
          activity: null,
          nowMs: now(),
        }))
        log(`[${watcher.name}] ${cancelled ? 'CANCELLED' : 'FAILED'} ${sourceId}: ${reason}${result.sessionId ? ` (session ${result.sessionId})` : ''}${usageNote(result)}`)
      }
    } catch (error) {
      if (!claimed) {
        refundLaunch(launchStamp)
        throw error
      }
      const reason = abortController.signal.aborted ? 'cancelled' : truncate(errorMessage(error))
      const infraNote = `⚠️ agent-dispatch infrastructure error — ${reason}`
      // Drain any queued progress writes first — a streamed-text write
      // landing after the note would silently replace it.
      await writes.catch(() => {})
      // Only post the infra note if no terminal reply landed yet: when the
      // error came from the *props* write that follows a delivered answer,
      // reconciling again would overwrite that answer, so leave the reply
      // intact and only flip props.
      if (!terminalReplyDelivered) {
        await reconcileReply(infraNote, {final: true, shape: 'block'}).catch(() => {})
      }
      // A queued retry preserves any Stop written before the next sweep.
      await graph.setTaskProps(sourceId, {
        ...failureProps(), error: reason, activity: null, nowMs: now(),
      }).catch(() => {})
      throw error
    } finally {
      if (sessionKey) running.delete(sessionKey)
      if (liveSessionKey) running.delete(liveSessionKey)
      abortControllers.delete(sourceId)
    }
  }

  const scheduleBlockTasks = async (tasks: BlockTask[], views: Map<string, BlockView>) => {
    if (tasks.length === 0) return
    const editing = await graph.beingEditedBlocks()
    for (const task of tasks) {
      const {watcher} = task
      const view = views.get(task.id) ?? {id: task.id, properties: {}}
      if (!belongsToWatcher(view, watcher)) continue
      const key = `block:${task.id}`
      if (running.has(key)) continue
      const preview = pendingDecision(task, view, editing.get(task.id))
      if (preview.reason === 'attempts-exhausted' || preview.reason === 'cancelled') {
        const reason = preview.reason
        launch(key, () => parkTask(task, reason))
        continue
      }
      // A channel session can finish independently. Clear only its Stop,
      // so a stale snapshot cannot overwrite its terminal status.
      if (preview.reason === 'clear-cancel') {
        await graph.clearCancel(task.id)
        log(`[${watcher.name}] cleared an un-actionable agent:cancel on ${task.id}`)
        continue
      }
      if (!preview.pending) continue
      if (capacityLeft() <= 0) return
      if (!spendBudgetLeft()) {
        log(`[${watcher.name}] runsPerHour budget (${config.runsPerHour}) exhausted — deferring ${task.id}`)
        return
      }
      // Budget is consumed at the launch DECISION (synchronously) — the
      // async task body would record too late to gate this same loop.
      const launchStamp = recordLaunch()
      launch(key, () => processBlockTask(task, launchStamp))
    }
  }

  const tickBacklinksWatcher = async (watcher: BacklinksWatcher) => {
    // Baseline stamp is taken BEFORE any awaited scan: a mention typed
    // while the first resolve/scan is in flight must not end up with
    // editedAtMs < baseline (it would be classed pre-baseline forever).
    const tickStartMs = now()
    const targetId = await targetPageId(watcher.target)

    // A property value block is never a task's source: the property belongs
    // to its owner, and while child-backed workspaces still dual-write the
    // cell the owner carries the same reference under the property's name,
    // where `isMention` decides it. Its own edge is plain content, so
    // `isMention` would count an attribution value as a mention and every
    // reply would summon the agent again. Once the cell goes, this must map
    // a value block to its owner instead of dropping it.
    const backlinks = await graph.backlinkSources(targetId)
    const values = backlinks.length === 0 ? new Set<string>() : await graph.propertyValueBlocks(backlinks.map(source => source.id))
    const sources = backlinks.filter(source => !values.has(source.id) && isMention(source.sourceFields))

    // First sight of this watcher: record the baseline and fire nothing.
    // Pointing a watcher at an established page must not claim (and
    // bill) its historical backlinks — only blocks edited after this
    // moment become tasks. Delete the watcher's entry in the state file
    // to re-baseline deliberately.
    const baselineMs = await state.getBaseline(watcher.name)
    if (baselineMs === null) {
      await state.setBaseline(watcher.name, tickStartMs)
      log(`[${watcher.name}] baseline established — ${sources.length} pre-existing backlink(s) will never fire; blocks edited from now on will`)
      return
    }

    const views = await graph.blockViews(sources.map(source => source.id))
    await scheduleBlockTasks(sources.map(({id, deepLink}) => ({kind: 'mention', id, deepLink, baselineMs, watcher})), views)
  }

  const queryDiff = (watcher: QueryWatcher, rows: unknown[], prev: string[] | null) => {
    const diff = diffQueryRows(rows, prev)
    if (diff.invalidRows > 0) {
      log(`[${watcher.name}] skipped ${diff.invalidRows} row(s) without a string id — the watcher SQL must select an id column`)
    }
    if (diff.oversized) {
      log(`[${watcher.name}] query returned ${rows.length} rows (cursor bound ${MAX_CURSOR_IDS}) — refusing to diff; narrow the watcher SQL`)
    }
    return diff
  }

  /** Ask Agent keeps an active claim. Release it to a mention only after the
   *  local run settles or a restarted daemon verifies that its claim is stale. */
  const releaseAskedRow = async (task: Extract<BlockTask, {kind: 'row'}>): Promise<boolean> => {
    if (running.has(`block:${task.id}`)) return false
    const fresh = await currentTaskBlock(task)
    if (!fresh || rowTaskAction(fresh, task.watcher, task.baselineMs) !== 'release' || hasFreshRunningClaim(fresh, now())) return false
    await graph.setTaskProps(task.id, {
      status: 'queued', watcher: '', attempts: 0, activity: null, error: null, cancel: null, nowMs: now(),
    })
    log(`[${task.watcher.name}] released ${task.id} for its requested mention`)
    return true
  }

  const tickRowTasks = async (watcher: QueryWatcher) => {
    const key = JSON.stringify([config.workspaceId, watcher.name])
    const tickStartMs = now()
    const saved = await state.getRowTasks(key)
    const rows = await graph.sqlAll(watcher.sql, watcher.params).catch(error => {
      if (!saved) throw error
      log(`[${watcher.name}] discovery SQL failed; checking saved rows: ${errorMessage(error)}`)
      return []
    })
    const diff = queryDiff(watcher, rows, saved?.baselineIds ?? null)
    if (!saved && diff.oversized) return
    const candidates = new Map<string, {row: QueryRow, saved: boolean}>()
    for (const row of saved?.pending ?? []) candidates.set(row.id, {row, saved: true})
    for (const row of diff.newRows) {
      if (!candidates.has(row.id)) candidates.set(row.id, {row, saved: false})
    }
    const ids = saved ? [...candidates.keys()] : diff.seenIds
    const views = await graph.blockViews(ids, config.workspaceId)
    for (const id of ids) {
      if (!views.has(id)) log(`[${watcher.name}] skipped ${id}: no live block with this id in the configured workspace`)
    }
    if (!saved) {
      await state.setRowTasks(key, {baselineMs: tickStartMs, baselineIds: [...views.keys()], pending: []})
      log(`[${watcher.name}] row-task baseline established (${views.size} existing blocks)`)
      return
    }

    const pending: QueryRow[] = []
    const tasks: BlockTask[] = []
    for (const candidate of candidates.values()) {
      const {row} = candidate
      const view = views.get(row.id)
      if (!view) continue
      const task = {kind: 'row' as const, id: row.id, watcher, row, baselineMs: saved.baselineMs}
      const action = rowTaskAction(view, watcher, saved.baselineMs)
      if (action === 'run') {
        tasks.push(task)
        pending.push(row)
      } else if (action === 'release' && candidate.saved && !await releaseAskedRow(task)) {
        pending.push(row)
      }
    }
    // Keep the original columns until the graph reports a terminal state,
    // including while the budget or an editor holds the task.
    if (pending.length !== saved.pending.length || pending.some((row, i) => row !== saved.pending[i])) {
      await state.setRowTasks(key, {...saved, pending})
    }
    await scheduleBlockTasks(tasks, views)
  }

  const tickQueryWatcher = async (watcher: QueryWatcher) => {
    if (watcher.rowTasks) return tickRowTasks(watcher)
    const key = `query:${watcher.name}`
    if (running.has(key)) return

    const rows = await graph.sqlAll(watcher.sql, watcher.params)
    const prev = await state.getCursor(watcher.name)
    const diff = queryDiff(watcher, rows, prev)
    if (diff.oversized) return

    if (prev === null) {
      await state.setCursor(watcher.name, diff.seenIds)
      log(`[${watcher.name}] baseline established (${diff.seenIds.length} rows) — future rows will trigger`)
      return
    }
    if (diff.newRows.length === 0) return
    if (capacityLeft() <= 0) return
    if (!spendBudgetLeft()) {
      log(`[${watcher.name}] runsPerHour budget (${config.runsPerHour}) exhausted — deferring ${diff.newRows.length} new row(s)`)
      return
    }

    const batch = diff.newRows.slice(0, watcher.maxRowsPerFire)
    const overflow = diff.newRows.length - batch.length
    const prompt = renderQueryPrompt(watcher.prompt, {
      newRows: overflow > 0 ? [...batch, {id: '(truncated)', note: `${overflow} more new rows omitted — re-query for the rest`}] : batch,
      watcherName: watcher.name,
    })

    if (watcher.delivery === 'channel') {
      // Deliver FIRST, cursor after: a cheap POST has no re-bill risk, and
      // advancing the cursor before a failed delivery would lose these rows
      // permanently (no graph-side state to sweep). The launch is counted
      // only AFTER delivery succeeds — a failed POST bills nothing, and
      // counting it would let a down listener drain the hourly budget and
      // defer the rows even once it is back up.
      await deliverToChannel({content: prompt, meta: {watcher: watcher.name}})
      recordLaunch()
      await state.setCursor(watcher.name, diff.seenIds)
      log(`[${watcher.name}] delivered ${batch.length} new row(s) to the ambient channel session`)
      return
    }

    // Spawn mode: claim-at-cursor BEFORE the run so a persistently
    // failing (billed) prompt can't re-fire every tick.
    await state.setCursor(watcher.name, diff.seenIds)
    recordLaunch()
    log(`[${watcher.name}] firing for ${batch.length} new row(s)${overflow > 0 ? ` (+${overflow} truncated)` : ''}`)
    launch(key, async () => {
      // Query runs aren't threaded, so there is no block to persist the
      // session id to — logging it as it streams is the only record, and
      // the only way to inspect a run while it is live.
      let loggedSession: string | null = null
      const result = await runTask(runOptionsFor(watcher, prompt, undefined, event => {
        if (event.kind === 'session' && !loggedSession) {
          loggedSession = event.sessionId
          log(`[${watcher.name}] session ${event.sessionId}`)
        }
      }))
      const session = result.sessionId ?? loggedSession
      if (result.ok) {
        log(`[${watcher.name}] done${session ? ` (session ${session})` : ''}${usageNote(result)}: ${truncate(result.resultText.trim(), 200)}`)
      } else {
        log(`[${watcher.name}] FAILED${session ? ` (session ${session})` : ''}${usageNote(result)}: exit ${result.exitCode} ${truncate(result.stderr.trim())}`)
      }
    })
  }

  /** Honor Stop requests (agent:cancel) for every in-flight run, keyed off
   *  the live abortControllers rather than the backlink scan. A user can
   *  edit the [[claude]] link away while a run is live: the block keeps
   *  agent:status:running (so the chip's Stop still writes agent:cancel) yet
   *  drops out of backlinkSources, so a per-watcher scan would never reach
   *  it and the child would run to completion/timeout. The `?.` guards the
   *  race where a run settles and clears its controller during the
   *  blockViews await. */
  const sweepCancellations = async () => {
    if (abortControllers.size === 0) return
    const ids = [...abortControllers.keys()]
    const views = await graph.blockViews(ids)
    for (const id of ids) {
      if (!views.get(id)?.properties?.[PROPS.cancel]) continue
      log(`[cancel] aborting ${id} (Stop requested)`)
      abortControllers.get(id)?.abort()
      abortControllers.delete(id)
    }
  }

  const tick = async () => {
    if (!launchTimesLoaded) {
      launchTimes = await state.getLaunchTimes()
      pruneLaunchTimes()
      launchTimesLoaded = true
    }
    // Before scanning for new work, honor any pending Stop — independent
    // of whether the target block still links [[claude]] (see above).
    await sweepCancellations().catch(error => log(`[cancel] sweep failed: ${errorMessage(error)}`))
    for (const watcher of config.watchers) {
      try {
        if (watcher.kind === 'backlinks') {
          await tickBacklinksWatcher(watcher)
        } else {
          await tickQueryWatcher(watcher)
        }
      } catch (error) {
        // Drop cached page ids on failure — the page may have been
        // deleted/recreated; the next tick re-resolves.
        if (watcher.kind === 'backlinks') pageIdCache.delete(watcher.target)
        log(`[${watcher.name}] tick failed: ${errorMessage(error)}`)
      }
    }
  }

  /** Await all launched runs — shutdown + tests. */
  const drain = async () => {
    while (running.size > 0) await Promise.allSettled([...running.values()])
  }

  return {tick, drain, running}
}

export type Engine = ReturnType<typeof createEngine>
