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
import type { StateStore } from './state.js'
import { decidePending, diffQueryRows, findThreadSession, MAX_ATTEMPTS, MAX_CURSOR_IDS, taskAttempts } from './watchers.js'
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
  /** Sleep between deliverReply retries — injected so tests run instantly
   *  (default is a real timer). */
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
 *  error from the bridge (commands.ts updateBlock; repo.load filters
 *  `deleted = 0`). Used to tell "placeholder was deleted, create a fresh
 *  reply" apart from a transient bridge failure that must NOT spawn a
 *  duplicate reply. Matched tightly (`block … not found`) so an unrelated
 *  "not found" transient (a future "workspace not found" etc.) can't be
 *  misread as a deleted placeholder and trigger a duplicate reply. */
const isBlockNotFound = (error: unknown): boolean =>
  /\bblock\b.*\bnot found\b/i.test(errorMessage(error))

/** Backoff schedule for retrying the IDEMPOTENT streamed terminal write
 *  (updateBlockContent) past a transient bridge blip — recovering the
 *  billed answer instead of losing it to `status:error`. Bounded and
 *  short (≈1.7s worst case) so a genuinely-down bridge fails fast. Only
 *  the same-block/same-text update is retried; createReply is NOT (not
 *  idempotent — a half-succeeded create would duplicate the reply). */
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
    await graph.setTaskProps(sourceId, {status: 'error', error: reason, nowMs: now()})
    await graph.createReply(sourceId, `⚠️ agent-dispatch: ${reason}. Delete the agent:* properties to retry.`).catch(() => {})
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

    // Hoisted so the infra-catch below can prefer updating an
    // already-created streamed reply block over posting a new one —
    // and can drain the progress-write chain first, so a queued
    // streamed-text write never lands AFTER (and clobbers) the note.
    let replyId: string | null = null
    let writes: Promise<unknown> = Promise.resolve()
    // Last cumulative text streamed into the reply — kept so a FAILED run
    // that had already streamed most of its (billed) answer appends the
    // error note to that partial instead of discarding it.
    let lastStreamedText = ''
    // Set once a TERMINAL reply (the ok answer, or the failure/partial
    // note) has been written. The infra-catch checks it so a transient
    // blip on the *terminal props write* — which lands AFTER a good reply
    // — can't re-enter deliverReply and clobber the answer (streamReply)
    // or post a duplicate (fresh reply). See the catch below.
    let terminalReplyDelivered = false
    // Abort handle for THIS run — a cancel request (agent:cancel, detected
    // in the tick) aborts it, killing the child. `signal.aborted` after the
    // run tells a user cancel apart from a timeout/crash. Registered just
    // before the run launches (below), deleted in finally.
    const abortController = new AbortController()

    // Land `text` on the streamed placeholder if one exists, else create a
    // fresh reply. The streamed update is idempotent (same block, same
    // text), so a transient bridge blip on the terminal write is RETRIED
    // (bounded backoff) to recover the billed answer rather than lose it.
    // A NOT-FOUND (the user deleted the placeholder mid-run) breaks out to
    // a single createReply. createReply itself is NOT retried — it isn't
    // idempotent, so a half-succeeded create would duplicate the reply.
    const deliverReply = async (text: string): Promise<void> => {
      if (!replyId) { await graph.createReply(sourceId, text); return }
      for (let attempt = 0; ; attempt += 1) {
        try {
          await graph.updateBlockContent(replyId, text)
          return
        } catch (error) {
          if (isBlockNotFound(error)) { await graph.createReply(sourceId, text); return }
          if (attempt >= DELIVER_RETRY_DELAYS_MS.length) throw error
          log(`[${watcher.name}] retrying reply write for ${sourceId} after a transient error: ${errorMessage(error)}`)
          await delay(DELIVER_RETRY_DELAYS_MS[attempt])
        }
      }
    }

    try {
      const attempt = taskAttempts(block) + 1
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

      // streamReply: post the reply block EARLY so its content can be
      // updated as the run streams, instead of created once at the end.
      if (watcher.streamReply) {
        const streamedReply = await graph.createReply(sourceId, `💭 ${executorLabel(runner.executor)} is working…`)
        replyId = streamedReply.id
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
      const onEvent = (event: RunEvent) => {
        if (event.kind === 'activity') {
          if (event.label === lastActivity) return
          lastActivity = event.label
          queueWrite(() => graph.setActivity(sourceId, event.label))
        } else if (event.kind === 'text') {
          const streamedReplyId = replyId
          if (!streamedReplyId) return
          lastStreamedText = event.text
          const nowMs = now()
          if (nowMs - lastTextWriteMs < 1_500) return
          lastTextWriteMs = nowMs
          queueWrite(() => graph.updateBlockContent(streamedReplyId, event.text))
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
          queueWrite(() => graph.setSession(sourceId, stored))
        }
      }

      const result = await runTask(runOptionsFor(watcher, prompt, session ?? undefined, onEvent, abortController.signal))
      await writes // ordering guarantee: no progress write races the final one below

      if (result.ok) {
        // Deliberately NOT gated on signal.aborted: if the child completed
        // cleanly in the same instant a Stop landed (exit 0 raced SIGTERM),
        // the billed answer is real — keep it as `done` rather than discard
        // it as `cancelled`. Only a run that ended WITHOUT a result (the
        // error branch below) inspects signal.aborted to label the reason.
        const finalText = result.resultText.trim() || `(${runner.executor} returned an empty reply)`
        await deliverReply(finalText)
        terminalReplyDelivered = true
        await graph.setTaskProps(sourceId, {status: 'done', session: storedSessionFor(runner.executor, result.sessionId), activity: null, cancel: null, nowMs: now()})
        log(`[${watcher.name}] done ${sourceId}${result.sessionId ? ` (session ${result.sessionId})` : ''}`)
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
        // Preserve a streamed partial: a run that timed out (or died)
        // after streaming most of its billed answer keeps that text with
        // the note appended, rather than replacing it with the one-liner.
        const partial = lastStreamedText.trim()
        await deliverReply(partial ? `${partial}\n\n${failureNote}` : failureNote)
        terminalReplyDelivered = true
        await graph.setTaskProps(sourceId, {status: 'error', error: reason, session: storedSessionFor(runner.executor, result.sessionId), activity: null, cancel: null, nowMs: now()})
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
      // Only post the infra note if no terminal reply landed yet. If the
      // answer (or failure/partial note) was already delivered and the
      // error came from the *props* write that follows it, re-delivering
      // would overwrite the good answer (streamReply) or duplicate it
      // (fresh reply) — so we leave the reply intact and only flip props.
      if (!terminalReplyDelivered) await deliverReply(infraNote).catch(() => {})
      // Clear agent:cancel like the done/error terminal writes: a Stop
      // may have set it (this catch can run right after the child was
      // aborted, e.g. the reply write then failed). Left behind, the flag
      // survives askAgent's retry-reset and would abort the fresh run on
      // its very next tick.
      await graph.setTaskProps(sourceId, {status: 'error', error: reason, activity: null, cancel: null, nowMs: now()}).catch(() => {})
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
      if (!spendBudgetLeft()) {
        log(`[${watcher.name}] runsPerHour budget (${config.runsPerHour}) exhausted — deferring ${source.id}`)
        return
      }
      // Budget is consumed at the launch DECISION (synchronously) — the
      // async task body would record too late to gate this same loop.
      // Bails that provably spawned nothing (duplicate session, lost
      // claim, block gone) refund their slot inside processMention.
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
    recordLaunch()
    log(`[${watcher.name}] firing for ${batch.length} new row(s)${overflow > 0 ? ` (+${overflow} truncated)` : ''}`)
    launch(key, async () => {
      // Log the session id the instant it streams (same as the mention
      // path) so a query-triggered run is findable/inspectable while it's
      // live, not just from the terminal line. Query runs aren't threaded,
      // so there's no block to persist it to — the log is the only record.
      let loggedSession: string | null = null
      const result = await runTask(runOptionsFor(watcher, prompt, undefined, event => {
        if (event.kind === 'session' && !loggedSession) {
          loggedSession = event.sessionId
          log(`[${watcher.name}] session ${event.sessionId}`)
        }
      }))
      const session = result.sessionId ?? loggedSession
      if (result.ok) {
        log(`[${watcher.name}] done${session ? ` (session ${session})` : ''}: ${truncate(result.resultText.trim(), 200)}`)
      } else {
        log(`[${watcher.name}] FAILED${session ? ` (session ${session})` : ''}: exit ${result.exitCode} ${truncate(result.stderr.trim())}`)
      }
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
