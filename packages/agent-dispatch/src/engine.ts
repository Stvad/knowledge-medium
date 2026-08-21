/**
 * Orchestration: one `tick()` scans all watchers, claims pending work,
 * and launches bounded-concurrency agent runs. Pure wiring — every
 * decision lives in watchers.ts, every side effect behind an injected
 * dependency, so the whole flow is testable with in-memory fakes.
 */
import os from 'node:os'
import { errorMessage } from '@knowledge-medium/agent-cli/client'
import { renderSubtreeOutline, type SubtreeOutlineRow } from '@knowledge-medium/agent-cli/subtreeOutline'
import type { BacklinksWatcher, DaemonConfig, QueryWatcher, Watcher } from './config.js'
import { PROPS } from './config.js'
import type { Graph } from './graph.js'
import type { AgentRunOptions, AgentRunResult, RunEvent } from './runner.js'
import { resumeOptionsForRun, type AgentResumeOptions } from './resumeCommand.js'
import type { StateStore } from './state.js'
import { classifyRunFailure, retryBackoffMs, type RunFailureClass } from './runFailure.js'
import { decidePending, diffQueryRows, findThreadSession, MAX_ATTEMPTS, MAX_CURSOR_IDS, taskAttempts, type BlockView } from './watchers.js'
import { DEFAULT_MENTION_CHANNEL_PROMPT, renderMentionPrompt, renderQueryPrompt } from './prompt.js'
import { KM_MCP_ALLOWED_TOOLS } from '@knowledge-medium/agent-cli/mcpShared'

export interface ChannelEvent {
  content: string
  meta: Record<string, string>
}

export interface EngineDeps {
  config: DaemonConfig
  graph: Graph
  state: StateStore
  runTask: (options: AgentRunOptions) => Promise<AgentRunResult>
  /** EXPERIMENTAL: push an event into the ambient channel session
   *  (delivery: 'channel' watchers). Throws if unreachable. */
  deliverToChannel: (event: ChannelEvent) => Promise<void>
  /** Generated --mcp-config path; null disables graph tools for runs. */
  mcpConfigPath: string | null
  log: (message: string) => void
  now?: () => number
  /** Sleep between terminal reply-reconcile retries — injected so tests run
   *  instantly (default is a real timer). */
  delay?: (ms: number) => Promise<void>
}

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
 *  Whitespace is collapsed to one line and non-printable control bytes
 *  are stripped: graph content can be synced/imported from an external
 *  source, and raw ANSI/OSC escapes would otherwise let it spoof or clear
 *  a `tail -f` of the log. JSON-encoded so any embedded quote/backslash
 *  stays unambiguous; empty content renders as `(empty)`. */
const logPreview = (content: string | null | undefined): string => {
  const cleaned = [...(content ?? '').replace(/\s+/g, ' ')]
    .filter(isLoggable)
    .join('')
    .trim()
  return cleaned ? JSON.stringify(truncate(cleaned, 100)) : '(empty)'
}

/** A deleted block surfaces as an `updateBlock: block <id> not found`
/** Backoff schedule for retrying the IDEMPOTENT terminal reply reconcile
 *  past a transient bridge blip — recovering the billed answer instead of
 *  losing it to `status:error`. Bounded and short (≈1.7s worst case) so a
 *  genuinely-down bridge fails fast. Safe because reconcile is keyed by
 *  `replyKey`: a re-send converges to the same tree rather than duplicating
 *  it (unlike the old one-shot subtree create, which could NOT be retried). */
const DELIVER_RETRY_DELAYS_MS = [200, 500, 1000] as const

/** agent:session values are executor-scoped: codex thread ids are
 *  stored as `codex:<id>`, claude session ids bare (back-compat — every
 *  session stored before executors existed is a claude one). A
 *  follow-up under the OTHER executor starts a fresh thread instead of
 *  forwarding the foreign id to resume, which fails the run outright
 *  (`codex exec resume` only accepts codex thread ids, and vice versa). */
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
  const {config, graph, state, runTask, deliverToChannel, mcpConfigPath, log} = deps
  const now = deps.now ?? Date.now
  const delay = deps.delay ?? ((ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms)))

  /** Live work, keyed by block id / query-watcher key / thread session.
   *  One structure serves the double-claim guard, the capacity gate,
   *  and drain(). */
  const running = new Map<string, Promise<void>>()
  /** Abort handle per in-flight mention run, keyed by source block id, so
   *  a cancel request (agent:cancel) can kill THAT run — and only it.
   *  Set when the run launches, deleted in its finally. */
  const abortControllers = new Map<string, AbortController>()
  /** target alias → {id, resolvedAt}. TTL'd: a page deleted-then-
   *  recreated gets a NEW id, and a stale id doesn't error (backlinks of
   *  a missing target just return []), so an unbounded cache would
   *  silently poll a dead id forever. */
  const pageIdCache = new Map<string, {id: string, resolvedAt: number}>()
  const PAGE_ID_TTL_MS = 10 * 60_000
  /** Launch timestamps within the rolling hour — the global spend
   *  circuit-breaker. PERSISTED (state.ts): an in-memory-only log would
   *  re-arm a full budget on every crash/restart, unbounding the exact
   *  trigger-loop the cap exists to stop. Seeded from disk on first tick. */
  let launchTimes: number[] = []
  let launchTimesLoaded = false

  /** Infrastructure cooldown — the "don't chew the queue" half of the
   *  retryable-failure handling. One run failing because the account is out
   *  of credits says nothing about THAT task and everything about the next
   *  ten, so the daemon stops launching until the cooldown lapses, then
   *  lets exactly one probe through. Deliberately in-memory only: it's an
   *  optimisation over the per-task `agent:retry-after` (which IS durable),
   *  and a restart re-deriving it costs one extra doomed spawn.
   *
   *  Keyed by LANE rather than global. An outage belongs to one credential
   *  or one transport: a spent Claude subscription says nothing about a
   *  Codex watcher, and a dead channel listener says nothing about either.
   *  A single global window both stalls healthy watchers and — the worse
   *  half — lets a success on a healthy lane clear the failing lane's
   *  window, so that lane resumes chewing its queue: the exact bug this
   *  whole path exists to stop. */
  interface Cooldown {
    until: number
    consecutiveFailures: number
    reason: string
    /** When the CURRENT window was armed. A task whose `agent:asked-at`
     *  postdates it was re-queued by the user while we were cooling, which
     *  is what earns it the probe (see `inInfraCooldown`). */
    armedAt: number
    /** The window we last logged, so a cooldown is announced once, not
     *  once per watcher per tick. */
    logged: number
  }
  const cooldowns = new Map<string, Cooldown>()

  /** The failure domain a watcher shares with others: the credential its
   *  spawned runs bill, or the channel its deliveries go to. */
  const laneOf = (watcher: Watcher): string =>
    watcher.delivery === 'channel' ? 'channel' : watcher.runner.executor

  const cooldownFor = (lane: string): Cooldown => {
    let state = cooldowns.get(lane)
    if (!state) {
      state = {until: 0, consecutiveFailures: 0, reason: '', armedAt: 0, logged: 0}
      cooldowns.set(lane, state)
    }
    return state
  }

  const noteInfraFailure = (lane: string, failure: RunFailureClass, sourceLabel: string): number => {
    const state = cooldownFor(lane)
    state.consecutiveFailures += 1
    const backoff = retryBackoffMs(state.consecutiveFailures)
    state.until = now() + backoff
    state.armedAt = now()
    state.reason = failure.label
    log(`[${sourceLabel}] ${failure.label} — nothing was attempted; pausing new ${lane} runs for ${Math.round(backoff / 1000)}s (infrastructure failure ${state.consecutiveFailures} in a row)`)
    return state.until
  }

  /** Any run that reached the model proves this lane's infrastructure is
   *  back — including one that failed on its own merits. */
  const clearInfraCooldown = (lane: string) => {
    cooldowns.delete(lane)
  }

  /** Reserve the post-cooldown probe, synchronously, at the launch
   *  decision. `inInfraCooldown` opens for EVERY source in the scan the
   *  instant a window lapses and nothing re-arms until a run's async
   *  result lands — so with `maxConcurrent > 1` a lapsed window launches a
   *  full concurrency-worth of doomed runs instead of the one probe.
   *  Re-arming the SAME backoff here holds the rest back until the probe
   *  answers: its outcome then either clears the lane (it reached the
   *  model) or extends it (it failed again), and if the outcome touches
   *  neither, the window still lapses on its own — so this can defer a
   *  lane but never wedge one.
   *
   *  Also what bounds a bulk "Retry all failed": moving `armedAt` forward
   *  spends the asked-at bypass below for every task but the first. */
  const reserveProbe = (lane: string) => {
    const state = cooldowns.get(lane)
    if (!state || state.consecutiveFailures === 0) return
    state.until = now() + retryBackoffMs(state.consecutiveFailures)
    state.armedAt = now()
  }

  const inInfraCooldown = (lane: string, source?: BlockView): boolean => {
    const state = cooldowns.get(lane)
    if (!state || now() >= state.until) return false
    // An explicit user re-queue (Retry now / Retry all) stamped AFTER this
    // window was armed is a deliberate probe: the user has just fixed the
    // cause — topped up credits, re-ran `claude login` — and the durable
    // `agent:retry-after` their gesture cleared is only half the clock.
    // Without this, the in-memory half ignores the gesture for up to five
    // minutes and "Retry now" silently does nothing. Exactly one gets
    // through: reserveProbe moves `armedAt` past the rest.
    const askedAt = source?.properties?.[PROPS.askedAt]
    if (typeof askedAt === 'number' && askedAt > state.armedAt) return false
    if (state.logged !== state.until) {
      state.logged = state.until
      log(`deferring new ${lane} runs until ${new Date(state.until).toISOString()} (${state.reason})`)
    }
    return true
  }

  // `session:` placeholders (thread-dedup, added in processMention) share
  // the `running` map but are NOT launches — exclude them so one --resume
  // follow-up doesn't consume two of maxConcurrent's slots.
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
  // The .finally below deletes the key unconditionally, so if two live
  // promises ever shared one key, the first to settle would evict the
  // other from `running` — breaking drain()/capacity accounting for it.
  // Today no path collides (serial ticks + the running.has prefilter +
  // mutually-exclusive claim/park branches keep each source.id/query:/
  // session: key to one live promise); this comment pins that requirement.
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
          ...(mcpConfigPath ? KM_MCP_ALLOWED_TOOLS : []),
          ...config.defaultAllowedTools,
          ...runner.allowedTools,
        ])]
        : [],
      mcpConfigPath: mcpConfigPath ?? undefined,
      model: runner.model,
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

  /** Park a task that exhausted its retries. Re-read + re-decide first
   *  (the pre-filter used a tick-start snapshot; the ambient session may
   *  have closed it since), then write the terminal `error` props FIRST
   *  so the state sticks even if the reply write fails — otherwise a
   *  createReply-succeeds / setTaskProps-fails split would re-enter every
   *  tick and spam ⚠️ blocks into the user's notes (the one write path
   *  with no billed-run circuit breaker). */
  const parkExhausted = async (watcher: BacklinksWatcher, sourceId: string) => {
    const fresh = await graph.getBlock(sourceId)
    if (decidePending({source: fresh ?? {id: sourceId}, nowMs: now()}).reason !== 'attempts-exhausted') return
    const reason = `gave up after ${MAX_ATTEMPTS} attempts (runs kept crashing or the channel session never closed the task)`
    await graph.setTaskProps(sourceId, {status: 'error', error: reason, retryAfter: null, nowMs: now()})
    await graph.createReply(sourceId, `⚠️ agent-dispatch: ${reason}. Use the chip's Retry action (or delete the agent:* properties) to re-run it.`).catch(() => {})
    log(`[${watcher.name}] parked ${sourceId}: ${reason}`)
  }

  const processMention = async (
    watcher: BacklinksWatcher, sourceId: string, deepLink: string, baselineMs: number, launchStamp: number,
    quietExempt: boolean,
  ) => {
    const {runner} = watcher
    // Pre-claim bails spawned nothing — refund the budget slot recorded
    // at the launch decision so phantom launches can't defer real work.
    const block = await graph.getBlock(sourceId)
    if (!block) return refundLaunch(launchStamp)
    const decision = decidePending({source: block, nowMs: now(), quietMs: watcher.quietMs, baselineMs, quietExempt})
    if (!decision.pending) return refundLaunch(launchStamp)
    const ancestorBlocks = await graph.ancestors(sourceId)

    // Resolve the thread session BEFORE claiming so two follow-ups in
    // one thread can't run `--resume <same session>` concurrently.
    const session = watcher.resume
      ? resumableSessionFor(runner.executor, findThreadSession(block, ancestorBlocks))
      : null
    const sessionKey = session ? `session:${session}` : null
    if (sessionKey && running.has(sessionKey)) return refundLaunch(launchStamp)
    if (sessionKey) running.set(sessionKey, Promise.resolve())

    // A fresh run's session id is unknown until mid-run (the runner emits
    // it on its first line). The instant we write it to the block,
    // findThreadSession resolves it for a follow-up nested under this
    // source — so a live session must ALSO hold a dedup key, or that
    // follow-up, claimed before this run finishes, would pass the guard
    // above and `--resume` the SAME session concurrently. Registered when
    // the session event arrives (below), released in finally. null until
    // (and unless) a resumable session shows up.
    let liveSessionKey: string | null = null

    // Progress-write chain — hoisted so the infra-catch below can drain it
    // first, so a queued streamed reconcile never lands AFTER (and clobbers)
    // the note.
    let writes: Promise<unknown> = Promise.resolve()
    // Last cumulative text streamed into the reply — kept so a FAILED run
    // that had already streamed most of its (billed) answer keeps that
    // partial (collapsed to a single note block) instead of discarding it.
    let lastStreamedText = ''
    // Set once the run's LAST reply write has landed (the ok answer, the
    // failure/partial note, or the retry-deferral note). The infra-catch
    // checks it so a transient blip on the *props write* — which lands
    // AFTER a good reply — can't re-enter the reply write and clobber the
    // answer. See the catch below.
    let terminalReplyDelivered = false
    // Whether runTask returned at all. Splits the catch's two very
    // different worlds: a throw BEFORE it is "we never got to try"
    // (retryable), a throw after is "the answer we already paid for failed
    // to land" (terminal — re-running would re-bill it).
    let runAttempted = false
    // Per-run reply identity + shape, set once `attempt` is known (below).
    // Every reconcile of this run tags its blocks with `replyKey`, so it
    // converges the SAME subtree in place; a rerun uses a fresh key and thus
    // posts a fresh reply. `replyShape` is the split choice: `'outline'`
    // splits the reply into a block hierarchy, `'block'` keeps it whole.
    let replyKey = ''
    let replyShape: 'outline' | 'block' = 'block'
    // Abort handle for THIS run — a cancel request (agent:cancel, detected
    // in the tick) aborts it, killing the child. `signal.aborted` after the
    // run tells a user cancel apart from a timeout/crash. Registered just
    // before the run launches (below), deleted in finally.
    const abortController = new AbortController()

    // The reply is a keyed block subtree the app reconciles to match
    // `markdown` — `shape:'outline'` splits it into a hierarchy, `'block'`
    // keeps it whole. Streaming is just repeated reconciles with the growing
    // text (the last passes `final`). Idempotent by `replyKey`, so the
    // terminal write is RETRIED (bounded backoff) to recover a transient
    // bridge blip: a re-send converges to the same tree, never duplicating.
    const reconcileReply = async (
      markdown: string,
      {final = false, shape = replyShape}: {final?: boolean, shape?: 'outline' | 'block'} = {},
    ): Promise<void> => {
      await graph.reconcileReplyTree(sourceId, markdown, {replyKey, shape, final})
    }
    const reconcileReplyWithRetry = async (
      markdown: string,
      opts: {final?: boolean, shape?: 'outline' | 'block'} = {},
    ): Promise<void> => {
      for (let attempt = 0; ; attempt += 1) {
        try {
          await reconcileReply(markdown, opts)
          return
        } catch (error) {
          if (attempt >= DELIVER_RETRY_DELAYS_MS.length) throw error
          log(`[${watcher.name}] retrying reply write for ${sourceId} after a transient error: ${errorMessage(error)}`)
          await delay(DELIVER_RETRY_DELAYS_MS[attempt])
        }
      }
    }

    const attempt = taskAttempts(block) + 1
    // Fresh reply subtree per attempt (a rerun posts a new reply, never
    // mutating the prior attempt's answer); split unless the watcher opted
    // out. Reconciles within THIS attempt share the key → converge in place.
    replyKey = `reply:${sourceId}:${attempt}`
    replyShape = watcher.splitReply ? 'outline' : 'block'

    /** Put the task BACK in the queue instead of parking it as failed:
     *  hand the attempt and the spend slot back, leave a "waiting" trace
     *  where the answer would go, and cool the whole daemon down. Shared by
     *  the two ways a run can fail WITHOUT having been attempted — a
     *  classified run result, and a throw around the spawn (executor not on
     *  PATH, bridge down, channel listener down). */
    const deferForRetry = async (
      failure: RunFailureClass,
      detail: string,
      resume: {session?: string | null, resumeOptions?: AgentResumeOptions | null} = {},
    ) => {
      const retryAfter = noteInfraFailure(laneOf(watcher), failure, watcher.name)
      // A run that never reached the model spent nothing, so the
      // runsPerHour slot comes back too — letting doomed attempts eat the
      // budget would defer REAL work for an hour once the outage lifts.
      // (Same reasoning as the pre-claim refunds above.)
      refundLaunch(launchStamp)
      const partial = lastStreamedText.trim()
      const waitingNote = `⏳ agent-dispatch: ${failure.label} — nothing ran; retrying automatically. (${detail})`
      // Replaces any streamed placeholder/partial in place (same replyKey,
      // since the attempt number is rolled back too), so the retry's real
      // answer converges onto this block rather than stacking under it.
      await reconcileReplyWithRetry(
        partial ? `${partial}\n\n${waitingNote}` : waitingNote,
        {final: true, shape: 'block'},
      ).catch(error => log(`[${watcher.name}] could not post the retry note for ${sourceId}: ${errorMessage(error)}`))
      terminalReplyDelivered = true
      await graph.setTaskProps(sourceId, {
        status: 'queued',
        error: `${failure.label} — waiting to retry (${detail})`,
        // Roll the attempt back. Attempts exist to cap a task that keeps
        // CRASHING; counting an outage against them would park the queue
        // after three ticks — the very bug this path fixes.
        attempts: attempt - 1,
        session: resume.session ?? undefined,
        resumeOptions: resume.resumeOptions,
        activity: null,
        cancel: null,
        retryAfter,
        nowMs: now(),
      })
      log(`[${watcher.name}] DEFERRED ${sourceId}: ${failure.label} (${detail})`)
    }

    try {
      const claimStamp = now()
      log(`[${watcher.name}] claiming ${sourceId} ${logPreview(block.content)} (${decision.reason}, attempt ${attempt})`)
      await graph.setTaskProps(sourceId, {
        status: 'running', watcher: watcher.name, executor: runner.executor, attempts: attempt, nowMs: claimStamp,
      })

      // Claim-verify: re-read and confirm OUR claim stuck — defends only
      // against a faster LOCAL overwrite (two daemons on one client, e.g.
      // launchd + a manual --once). It does NOT make cross-machine safe:
      // each daemon reads its own client, so two machines both see their
      // own write and proceed. Cross-machine safety relies on the
      // one-daemon-per-fleet constraint (README) + the pidfile.
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
      // before the child spawns sets signal.aborted, so runTask below starts
      // already-cancelled (execProcess skips the spawn) and parks
      // `error: cancelled`. Registered inside the try so the finally always
      // clears it (the claim-lost return above happens before this, so its
      // finally-delete is a harmless no-op).
      abortControllers.set(sourceId, abortController)

      const subtreeRows = await graph.getSubtree(sourceId)
      const defaultTemplate = watcher.delivery === 'channel' ? DEFAULT_MENTION_CHANNEL_PROMPT : undefined
      const prompt = renderMentionPrompt(watcher.prompt ?? defaultTemplate, {
        content: block.content ?? '',
        // includeProperties: the prompt needs block properties (e.g.
        // status='done') to reason about the subtree — a done sub-item
        // should be skipped, which the lean id+content outline can't convey.
        subtree: renderSubtreeOutline(subtreeRows as SubtreeOutlineRow[], {includeProperties: true}),
        // graph.ancestors is nearest-first; the prompt reads root→leaf.
        ancestors: ancestorBlocks.map(ancestor => ancestor.content ?? '').reverse(),
        blockId: sourceId,
        deepLink,
        watcherName: watcher.name,
        // Only spawn delivery posts (and thus splits) the reply — the
        // channel session writes its own, so don't nudge it.
        splitReply: watcher.delivery !== 'channel' && watcher.splitReply,
      })

      if (watcher.delivery === 'channel') {
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
      // once; the first streamed tick reconciles it into real content (the
      // same keyed write, so the placeholder just becomes the reply's first
      // block). Best-effort — a cosmetic spinner must not fail the run.
      if (watcher.streamReply) {
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

      let lastActivity: string | null = null
      let lastTextWriteMs = 0
      let sessionRecorded = false
      const resumeOptionsForSession = (sessionId: string | null) =>
        sessionId
          ? resumeOptionsForRun(runOptionsFor(watcher, prompt, sessionId, undefined, abortController.signal))
          : null
      const onEvent = (event: RunEvent) => {
        if (event.kind === 'activity') {
          if (event.label === lastActivity) return
          lastActivity = event.label
          queueWrite(() => graph.setActivity(sourceId, event.label))
        } else if (event.kind === 'text') {
          if (!watcher.streamReply) return
          lastStreamedText = event.text
          const nowMs = now()
          if (nowMs - lastTextWriteMs < 1_500) return
          lastTextWriteMs = nowMs
          // Reconcile the growing text into the reply subtree (best-effort,
          // single attempt — the next tick, or the terminal write, supersedes
          // a dropped one). Idempotent by replyKey, so ticks never duplicate.
          queueWrite(() => reconcileReply(event.text))
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
          // Claim a dedup key for the now-live session BEFORE exposing it
          // on the block (the register is synchronous; the block write is
          // only queued), so a follow-up can never observe the session
          // without also seeing the guard. The key mirrors exactly what a
          // child computes (resumableSessionFor over the stored value).
          // Skip when we already hold this key (a run that was itself a
          // resume) or someone else does — finally only deletes what we set.
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
      const result = await runTask(runOptions)
      // The run happened (whatever its outcome). Past this line a throw is
      // about DELIVERING a billed answer, not about failing to start one —
      // which is what the catch keys its defer-vs-park decision off.
      runAttempted = true
      await writes // ordering guarantee: no progress write races the final one below

      // Why the run ended, for a failure the user did NOT ask for. A
      // cancel is deliberate and terminal, so it's never classified.
      const failure = result.ok || abortController.signal.aborted ? null : classifyRunFailure(result)
      // A retryable CLASS only means "nothing ran" if nothing ran. A run
      // can stream a billed answer and THEN die on a transport error
      // (ECONNRESET mid-stream classifies as `network`): the model was
      // reached and the tokens are spent, so handing back the spend slot
      // and the attempt would let a repeating mid-stream disconnect bill
      // the same task without limit, outside `runsPerHour` entirely.
      // Assistant text is the proof — a session id is NOT, since the runner
      // emits it on the first line, before any model call. `resultText`
      // rather than `lastStreamedText` alone: the latter is only populated
      // for `streamReply` watchers, so a non-streaming one would look like
      // it had produced nothing.
      const reachedModel = Boolean(lastStreamedText.trim() || result.resultText.trim())

      if (result.ok) {
        // Deliberately NOT gated on signal.aborted: if the child completed
        // cleanly in the same instant a Stop landed (exit 0 raced SIGTERM),
        // the billed answer is real — keep it as `done` rather than discard
        // it as `cancelled`. Only a run that ended WITHOUT a result (the
        // error branch below) inspects signal.aborted to label the reason.
        const finalText = result.resultText.trim() || `(${runner.executor} returned an empty reply)`
        // Terminal write = the last reconcile of the run's reply subtree
        // (shape per splitReply). If the run streamed, this converges the
        // streamed tree onto the final text in place; if it didn't, it
        // creates the tree fresh. Retried (idempotent by replyKey) so a
        // transient bridge blip recovers rather than losing the billed answer.
        await reconcileReplyWithRetry(finalText, {final: true})
        terminalReplyDelivered = true
        await graph.setTaskProps(sourceId, {
          status: 'done',
          session: storedSessionFor(runner.executor, result.sessionId),
          resumeOptions: resumeOptionsForSession(result.sessionId),
          activity: null,
          cancel: null,
          retryAfter: null,
          nowMs: now(),
        })
        clearInfraCooldown(laneOf(watcher))
        log(`[${watcher.name}] done ${sourceId}${result.sessionId ? ` (session ${result.sessionId})` : ''}`)
      } else if (failure?.retryable && !reachedModel) {
        // NOT a task failure — the run never got to attempt it (out of
        // credits, expired login, rate limited, network down). Parking it
        // `error` here is what turned a single credit outage into a queue
        // of dead tasks.
        await deferForRetry(
          failure,
          truncate(result.stderr.trim() || result.failureText.trim() || `exit ${result.exitCode}`, 200),
          {
            session: storedSessionFor(runner.executor, result.sessionId),
            resumeOptions: resumeOptionsForSession(result.sessionId),
          },
        )
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
        // A failed run never splits — collapse to a single block (any
        // streamed partial + the note), keyed like the success write so a
        // retry recovers it in place. Preserves a streamed partial: a run
        // that died after streaming most of its billed answer keeps that
        // text with the note appended, rather than replacing it.
        const partial = lastStreamedText.trim()
        await reconcileReplyWithRetry(
          partial ? `${partial}\n\n${failureNote}` : failureNote,
          {final: true, shape: 'block'},
        )
        terminalReplyDelivered = true
        await graph.setTaskProps(sourceId, {
          status: 'error',
          error: reason,
          session: storedSessionFor(runner.executor, result.sessionId),
          resumeOptions: resumeOptionsForSession(result.sessionId),
          activity: null,
          cancel: null,
          retryAfter: null,
          nowMs: now(),
        })
        // A run that failed on its own merits still REACHED the model, so
        // the infrastructure is evidently fine — drop any cooldown a
        // previous outage left armed. A cancel proves nothing either way,
        // so it leaves the cooldown alone.
        if (!cancelled) clearInfraCooldown(laneOf(watcher))
        log(`[${watcher.name}] ${cancelled ? 'CANCELLED' : 'FAILED'} ${sourceId}: ${reason}${result.sessionId ? ` (session ${result.sessionId})` : ''}`)
      }
    } catch (error) {
      // Infra failure between claim and reply (bridge blip, spawn error,
      // channel down): leave a visible trace AND status=error props.
      const reason = truncate(errorMessage(error))
      const infraNote = `⚠️ agent-dispatch infrastructure error — ${reason}`
      // Drain any queued progress writes first — a streamed-text write
      // landing after the note would silently replace it.
      await writes.catch(() => {})
      // A throw BEFORE the run is the same "we couldn't try" case a
      // classified run failure is: `claudeBin` missing from launchd's PATH,
      // the bridge down, the channel listener not up. Parking here kills
      // every task the daemon touches for the duration, so defer instead.
      // Gated on runAttempted so a throw while delivering a BILLED answer
      // still parks — a re-run would have to pay for it again.
      const startupFailure = runAttempted || terminalReplyDelivered
        ? null
        : classifyRunFailure({stderr: reason, failureText: '', exitCode: null, timedOut: false})
      if (startupFailure?.retryable) {
        // Best-effort: if the defer itself can't be written the block stays
        // `running` and the stale sweep re-queues it, which is the same
        // fallback the parking path has always had.
        await deferForRetry(startupFailure, reason)
          .catch(deferError => log(`[${watcher.name}] could not defer ${sourceId}: ${errorMessage(deferError)}`))
        throw error
      }
      // Only post the infra note if no terminal reply landed yet. If the
      // answer (or failure/partial note) was already delivered and the error
      // came from the *props* write that follows it, reconciling again would
      // overwrite the good answer — so we leave the reply intact and only
      // flip props. Reconciled as a single block (keyed), so any streamed
      // partial collapses to the note rather than sitting beside it.
      if (!terminalReplyDelivered) {
        await reconcileReply(infraNote, {final: true, shape: 'block'}).catch(() => {})
      }
      // Clear agent:cancel like the done/error terminal writes: a Stop
      // may have set it (this catch can run right after the child was
      // aborted, e.g. the reply write then failed). Left behind, the flag
      // survives askAgent's retry-reset and would abort the fresh run on
      // its very next tick.
      await graph.setTaskProps(sourceId, {status: 'error', error: reason, activity: null, cancel: null, retryAfter: null, nowMs: now()}).catch(() => {})
      throw error
    } finally {
      if (sessionKey) running.delete(sessionKey)
      if (liveSessionKey) running.delete(liveSessionKey)
      abortControllers.delete(sourceId)
    }
  }

  const tickBacklinksWatcher = async (watcher: BacklinksWatcher, quietExemptBlockIds: ReadonlySet<string>) => {
    // Baseline stamp is taken BEFORE any awaited scan: a mention typed
    // while the first resolve/scan is in flight must not end up with
    // editedAtMs < baseline (it would be classed pre-baseline forever).
    const tickStartMs = now()
    const cached = pageIdCache.get(watcher.target)
    let targetId = cached && now() - cached.resolvedAt < PAGE_ID_TTL_MS ? cached.id : undefined
    if (!targetId) {
      targetId = await graph.resolvePageId(watcher.target)
      pageIdCache.set(watcher.target, {id: targetId, resolvedAt: now()})
    }

    const sources = await graph.backlinkSources(targetId)

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

    if (sources.length === 0) return

    // Cheap pre-filter (one batched query): already-processed mentions
    // must not consume launch slots or per-block round-trips. The same
    // decision re-runs with a fresh read inside processMention before
    // any claim is written.
    const views = await graph.blockViews(sources.map(source => source.id))
    for (const source of sources) {
      const view = views.get(source.id) ?? {id: source.id, properties: {}}
      // Clear a agent:cancel the daemon can't act on. sweepCancellations
      // aborts runs we OWN (a live abortController); but a Stop on a
      // channel-delivered task (whose child the ambient session owns, not
      // us) — or on a run stranded by a hard daemon kill — leaves
      // status:running with no controller here, so the sweep never fires and
      // the terminal write that clears the flag never comes: the chip would
      // read "cancelling…" forever. When a running block is flagged but we
      // hold no live run for it (not in `running`, no controller), the flag
      // is inert — clear it, preserving the block's status + timestamp so
      // the stale-running sweep is undisturbed. A spawn run mid-claim IS in
      // `running`, so its genuinely-pending Stop is never dropped here.
      if (
        view.properties?.[PROPS.cancel]
        && view.properties?.[PROPS.status] === 'running'
        && !running.has(source.id)
        && !abortControllers.has(source.id)
      ) {
        // Clear ONLY the cancel property — a merged single-key write that
        // never touches agent:status. The batched `views` snapshot is stale
        // by the time we get here, and a channel task's ambient session may
        // write status:done concurrently; a write that re-affirmed
        // status:running would revert that, and once agent:updated-at went
        // stale the stale-running sweep would REDELIVER the task (duplicate
        // work). A cancel-only write can't clobber a terminal status, and
        // clearing an already-satisfied flag is an idempotent no-op — so no
        // re-read is needed. status/updatedAt are left exactly as they are.
        await graph.clearCancel(source.id)
        log(`[${watcher.name}] cleared an un-actionable agent:cancel on ${source.id}`)
        continue
      }
      // Stop on a DEFERRED task: nothing is running to abort, so the flag
      // means "stop waiting to retry". Honour it as the terminal cancel the
      // running path writes — otherwise the only way out of an automatic
      // retry loop would be deleting the block's agent:* properties.
      if (
        view.properties?.[PROPS.cancel]
        && view.properties?.[PROPS.status] === 'queued'
        && !running.has(source.id)
      ) {
        await graph.setTaskProps(source.id, {
          status: 'error', error: 'cancelled', activity: null, cancel: null, retryAfter: null, nowMs: now(),
        })
        log(`[${watcher.name}] stopped retrying ${source.id} (Stop requested while deferred)`)
        continue
      }
      if (running.has(source.id)) continue
      const quietExempt = quietExemptBlockIds.has(source.id)
      const preview = decidePending({source: view, nowMs: now(), quietMs: watcher.quietMs, baselineMs, quietExempt})

      if (preview.reason === 'attempts-exhausted') {
        // Terminal write (once) so the pre-filter skips it forever.
        launch(source.id, () => parkExhausted(watcher, source.id))
        continue
      }
      if (!preview.pending) continue
      if (capacityLeft() <= 0) return
      // Gated HERE rather than at the top of the tick so a cooldown never
      // suppresses the non-launching work above (clearing an inert cancel,
      // parking an exhausted task) — it only stops NEW runs. `view` rides
      // along so a task the user explicitly re-queued gets to be the probe.
      if (inInfraCooldown(laneOf(watcher), view)) return
      if (!spendBudgetLeft()) {
        log(`[${watcher.name}] runsPerHour budget (${config.runsPerHour}) exhausted — deferring ${source.id}`)
        return
      }
      // Budget is consumed at the launch DECISION (synchronously) — the
      // async task body would record too late to gate this same loop.
      // Bails that provably spawned nothing (duplicate session, lost
      // claim, block gone) refund their slot inside processMention.
      reserveProbe(laneOf(watcher))
      const launchStamp = recordLaunch()
      launch(source.id, () => processMention(watcher, source.id, source.deepLink, baselineMs, launchStamp, quietExempt))
    }
  }

  const tickQueryWatcher = async (watcher: QueryWatcher) => {
    const key = `query:${watcher.name}`
    if (running.has(key)) return

    const rows = await graph.sqlAll(watcher.sql, watcher.params)
    const prev = await state.getCursor(watcher.name)
    const diff = diffQueryRows(rows, prev)
    if (diff.invalidRows > 0) {
      log(`[${watcher.name}] skipped ${diff.invalidRows} row(s) without a string id — the watcher SQL must select an id column`)
    }
    if (diff.oversized) {
      log(`[${watcher.name}] query returned ${rows.length} rows (cursor bound ${MAX_CURSOR_IDS}) — refusing to diff; narrow the watcher SQL`)
      return
    }

    if (prev === null) {
      await state.setCursor(watcher.name, diff.seenIds)
      log(`[${watcher.name}] baseline established (${diff.seenIds.length} rows) — future rows will trigger`)
      return
    }
    if (diff.newRows.length === 0) return
    if (capacityLeft() <= 0) return
    // Query rows are especially costly to fire into an outage: the cursor
    // advances before the run, so a doomed launch DROPS them (the rollback
    // below is best-effort). Hold them instead — the cursor stays put and
    // the same rows re-diff once the cooldown lapses.
    if (inInfraCooldown(laneOf(watcher))) return
    if (!spendBudgetLeft()) {
      log(`[${watcher.name}] runsPerHour budget (${config.runsPerHour}) exhausted — deferring ${diff.newRows.length} new row(s)`)
      return
    }
    // One fire per lapsed window here too — this watcher is single-flight
    // (`running.has(key)`), but a SECOND query watcher on the same lane
    // would otherwise fire into the same outage in this very tick.
    reserveProbe(laneOf(watcher))

    const batch = diff.newRows.slice(0, watcher.maxRowsPerFire)
    const overflow = diff.newRows.length - batch.length
    const prompt = renderQueryPrompt(watcher.prompt, {
      newRows: overflow > 0 ? [...batch, {id: '(truncated)', note: `${overflow} more new rows omitted — re-query for the rest`}] : batch,
      watcherName: watcher.name,
    })

    if (watcher.delivery === 'channel') {
      // Deliver FIRST, cursor after: a cheap POST has no re-bill risk,
      // and advancing the cursor before a failed delivery would lose
      // these rows permanently (no graph-side state to sweep). The
      // launch is counted only AFTER delivery succeeds — a failed POST
      // bills nothing, and counting it would let a down listener drain
      // the hourly budget in ten polls and defer the rows even once
      // it's back up.
      await deliverToChannel({content: prompt, meta: {watcher: watcher.name}})
      recordLaunch()
      await state.setCursor(watcher.name, diff.seenIds)
      log(`[${watcher.name}] delivered ${batch.length} new row(s) to the ambient channel session`)
      return
    }

    // Spawn mode: claim-at-cursor BEFORE the run so a persistently
    // failing (billed) prompt can't re-fire every tick.
    await state.setCursor(watcher.name, diff.seenIds)
    const launchStamp = recordLaunch()
    log(`[${watcher.name}] firing for ${batch.length} new row(s)${overflow > 0 ? ` (+${overflow} truncated)` : ''}`)
    const lane = laneOf(watcher)
    launch(key, async () => {
      // Nothing was attempted, so put the rows BACK: this watcher has no
      // graph-side task state to sweep, and the cursor was advanced before
      // the run — leaving it advanced would silently drop exactly the rows
      // the outage prevented us from handling. Restoring `prev` also
      // re-surfaces rows that appeared during the run, which is the right
      // direction to be wrong in. Safe against a concurrent tick: the
      // `running.has(key)` guard above keeps this watcher single-flight.
      const deferRows = async (failure: RunFailureClass) => {
        refundLaunch(launchStamp)
        noteInfraFailure(lane, failure, watcher.name)
        await state.setCursor(watcher.name, prev)
          .then(() => log(`[${watcher.name}] DEFERRED ${batch.length} row(s): ${failure.label} — cursor rolled back, they re-fire after the cooldown`))
          .catch(error => log(`[${watcher.name}] ${failure.label}, but the cursor rollback FAILED (${errorMessage(error)}) — ${batch.length} row(s) will not re-fire`))
      }

      // Log the session id the instant it streams (same as the mention
      // path) so a query-triggered run is findable/inspectable while it's
      // live, not just from the terminal line. Query runs aren't threaded,
      // so there's no block to persist it to — the log is the only record.
      let loggedSession: string | null = null
      let result: AgentRunResult
      try {
        result = await runTask(runOptionsFor(watcher, prompt, undefined, event => {
          if (event.kind === 'session' && !loggedSession) {
            loggedSession = event.sessionId
            log(`[${watcher.name}] session ${event.sessionId}`)
          }
        }))
      } catch (error) {
        // runTask REJECTED rather than returning a failed result — the
        // executor binary is missing, the bridge is down. Classified from
        // the throw exactly as the mention path's catch does, because the
        // cursor is already advanced: without this the rows are dropped
        // permanently by the very outage the rest of this path defers.
        // An UNRECOGNISED throw stays terminal (cursor left advanced), so
        // a prompt that crashes the runner every time can't re-fire and
        // re-bill forever — the same degrade-to-today's-behaviour the
        // classifier has everywhere else.
        const reason = truncate(errorMessage(error))
        const failure = classifyRunFailure({stderr: reason, failureText: '', exitCode: null, timedOut: false})
        if (failure.retryable) await deferRows(failure)
        throw error
      }
      const session = result.sessionId ?? loggedSession
      if (result.ok) {
        clearInfraCooldown(lane)
        log(`[${watcher.name}] done${session ? ` (session ${session})` : ''}: ${truncate(result.resultText.trim(), 200)}`)
        return
      }
      const failure = classifyRunFailure(result)
      // Same "did it reach the model" test the mention path applies: a run
      // that streamed a billed answer before dying is not an un-attempt,
      // so it must not hand its spend slot back or re-fire its rows.
      if (!failure.retryable || result.resultText.trim()) {
        clearInfraCooldown(lane)
        log(`[${watcher.name}] FAILED${session ? ` (session ${session})` : ''}: exit ${result.exitCode} ${truncate(result.stderr.trim())}`)
        return
      }
      await deferRows(failure)
    })
  }

  /** Honor Stop requests (agent:cancel) for every in-flight run, keyed
   *  off the live abortControllers rather than the backlink scan. A run is
   *  claimed the instant its block links [[claude]], but the user can edit
   *  that link away while it runs: the block keeps agent:status:running
   *  (so the chip's Stop still writes agent:cancel) yet it no longer shows
   *  up in backlinkSources, so a per-watcher scan would never reach it and
   *  the child would run to completion/timeout. Polling the abort handles
   *  directly covers every live run regardless of its current link state.
   *  Runs once per tick (poll and push both route through tick()). The `?.`
   *  guards the race where a run settles and clears its controller during
   *  the blockViews await. */
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

  const NO_EXEMPTIONS: ReadonlySet<string> = new Set()

  /** `quietExemptByWatcher`: blocks whose quiet period was confirmed at
   *  the source (blur / settle), keyed by the EMITTING watcher — only
   *  that watcher may skip its still-typing gate for them, so a query
   *  watcher's short settle can't vouch against a backlinks watcher's
   *  longer quietMs. The push loop collects these from event payloads;
   *  sweep ticks pass nothing. */
  const tick = async (options: {quietExemptByWatcher?: ReadonlyMap<string, ReadonlySet<string>>} = {}) => {
    const quietExemptByWatcher = options.quietExemptByWatcher
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
          await tickBacklinksWatcher(watcher, quietExemptByWatcher?.get(watcher.name) ?? NO_EXEMPTIONS)
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
