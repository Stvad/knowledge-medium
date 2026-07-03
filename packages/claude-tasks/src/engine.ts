/**
 * Orchestration: one `tick()` scans all watchers, claims pending work,
 * and launches bounded-concurrency Claude runs. Pure wiring — every
 * decision lives in watchers.ts, every side effect behind an injected
 * dependency, so the whole flow is testable with in-memory fakes.
 */
import os from 'node:os'
import { errorMessage } from '@knowledge-medium/agent-cli/client'
import { renderSubtreeOutline, type SubtreeOutlineRow } from '@knowledge-medium/agent-cli/subtreeOutline'
import type { BacklinksWatcher, DaemonConfig, QueryWatcher, Watcher } from './config.js'
import type { Graph } from './graph.js'
import type { ClaudeRunOptions, ClaudeRunResult } from './runner.js'
import type { StateStore } from './state.js'
import { decidePending, diffQueryRows, findThreadSession, MAX_ATTEMPTS, MAX_CURSOR_IDS, taskAttempts } from './watchers.js'
import { DEFAULT_MENTION_CHANNEL_PROMPT, renderMentionPrompt, renderQueryPrompt } from './prompt.js'
import { KM_MCP_ALLOWED_TOOLS } from './mcpShared.js'

export interface ChannelEvent {
  content: string
  meta: Record<string, string>
}

export interface EngineDeps {
  config: DaemonConfig
  graph: Graph
  state: StateStore
  runTask: (options: ClaudeRunOptions) => Promise<ClaudeRunResult>
  /** EXPERIMENTAL: push an event into the ambient channel session
   *  (delivery: 'channel' watchers). Throws if unreachable. */
  deliverToChannel: (event: ChannelEvent) => Promise<void>
  /** Generated --mcp-config path; null disables graph tools for runs. */
  mcpConfigPath: string | null
  log: (message: string) => void
  now?: () => number
}

const truncate = (value: string, max = 500): string =>
  value.length > max ? `${value.slice(0, max)}…` : value

export const createEngine = (deps: EngineDeps) => {
  const {config, graph, state, runTask, deliverToChannel, mcpConfigPath, log} = deps
  const now = deps.now ?? Date.now

  /** Live work, keyed by block id / query-watcher key / thread session.
   *  One structure serves the double-claim guard, the capacity gate,
   *  and drain(). */
  const running = new Map<string, Promise<void>>()
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

  const launch = (key: string, work: () => Promise<void>) => {
    const promise = work()
      .catch(error => log(`[${key}] run crashed: ${errorMessage(error)}`))
      .finally(() => running.delete(key))
    running.set(key, promise)
  }

  const runOptionsFor = (watcher: Watcher, prompt: string, resumeSessionId?: string): ClaudeRunOptions => ({
    claudeBin: config.claudeBin,
    prompt,
    cwd: watcher.cwd ?? os.homedir(),
    allowedTools: [
      ...(mcpConfigPath ? KM_MCP_ALLOWED_TOOLS : []),
      ...watcher.allowedTools,
    ],
    mcpConfigPath: mcpConfigPath ?? undefined,
    model: watcher.model,
    resumeSessionId,
    timeoutMs: watcher.timeoutMs,
  })

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
    await graph.createReply(sourceId, `⚠️ claude-tasks: ${reason}. Delete the claude:* properties to retry.`).catch(() => {})
    log(`[${watcher.name}] parked ${sourceId}: ${reason}`)
  }

  const processMention = async (
    watcher: BacklinksWatcher, sourceId: string, deepLink: string, baselineMs: number, launchStamp: number,
  ) => {
    // Pre-claim bails spawned nothing — refund the budget slot recorded
    // at the launch decision so phantom launches can't defer real work.
    const block = await graph.getBlock(sourceId)
    if (!block) return refundLaunch(launchStamp)
    const decision = decidePending({source: block, nowMs: now(), quietMs: watcher.quietMs, baselineMs})
    if (!decision.pending) return refundLaunch(launchStamp)
    const ancestorBlocks = await graph.ancestors(sourceId)

    // Resolve the thread session BEFORE claiming so two follow-ups in
    // one thread can't run `--resume <same session>` concurrently.
    const session = watcher.resume ? findThreadSession(block, ancestorBlocks) : null
    const sessionKey = session ? `session:${session}` : null
    if (sessionKey && running.has(sessionKey)) return refundLaunch(launchStamp)
    if (sessionKey) running.set(sessionKey, Promise.resolve())

    try {
      const attempt = taskAttempts(block) + 1
      const claimStamp = now()
      log(`[${watcher.name}] claiming ${sourceId} (${decision.reason}, attempt ${attempt})`)
      await graph.setTaskProps(sourceId, {
        status: 'running', watcher: watcher.name, attempts: attempt, nowMs: claimStamp,
      })

      // Claim-verify: re-read and confirm OUR claim stuck — defends only
      // against a faster LOCAL overwrite (two daemons on one client, e.g.
      // launchd + a manual --once). It does NOT make cross-machine safe:
      // each daemon reads its own client, so two machines both see their
      // own write and proceed. Cross-machine safety relies on the
      // one-daemon-per-fleet constraint (README) + the pidfile.
      const verified = await graph.getBlock(sourceId)
      const props = verified?.properties ?? {}
      if (props['claude:watcher'] !== watcher.name || props['claude:updated-at'] !== claimStamp) {
        log(`[${watcher.name}] lost claim race on ${sourceId} — backing off`)
        refundLaunch(launchStamp)
        return
      }

      const subtreeRows = await graph.getSubtree(sourceId)
      const defaultTemplate = watcher.delivery === 'channel' ? DEFAULT_MENTION_CHANNEL_PROMPT : undefined
      const prompt = renderMentionPrompt(watcher.prompt ?? defaultTemplate, {
        content: block.content ?? '',
        subtree: renderSubtreeOutline(subtreeRows as SubtreeOutlineRow[]),
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

      const result = await runTask(runOptionsFor(watcher, prompt, session ?? undefined))

      if (result.ok) {
        await graph.createReply(sourceId, result.resultText.trim() || '(claude returned an empty reply)')
        await graph.setTaskProps(sourceId, {status: 'done', session: result.sessionId, nowMs: now()})
        log(`[${watcher.name}] done ${sourceId}${result.sessionId ? ` (session ${result.sessionId})` : ''}`)
      } else {
        const reason = result.timedOut
          ? `timed out after ${Math.round(watcher.timeoutMs / 1000)}s`
          : `exit ${result.exitCode}: ${truncate(result.stderr.trim() || result.resultText.trim() || 'no output')}`
        await graph.createReply(sourceId, `⚠️ claude-tasks run failed — ${reason}`)
        await graph.setTaskProps(sourceId, {status: 'error', error: reason, session: result.sessionId, nowMs: now()})
        log(`[${watcher.name}] FAILED ${sourceId}: ${reason}`)
      }
    } catch (error) {
      // Infra failure between claim and reply (bridge blip, spawn error,
      // channel down): leave a visible trace AND status=error props.
      const reason = truncate(errorMessage(error))
      await graph.createReply(sourceId, `⚠️ claude-tasks infrastructure error — ${reason}`).catch(() => {})
      await graph.setTaskProps(sourceId, {status: 'error', error: reason, nowMs: now()}).catch(() => {})
      throw error
    } finally {
      if (sessionKey) running.delete(sessionKey)
    }
  }

  const tickBacklinksWatcher = async (watcher: BacklinksWatcher) => {
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
      if (running.has(source.id)) continue
      const view = views.get(source.id) ?? {id: source.id, properties: {}}
      const preview = decidePending({source: view, nowMs: now(), quietMs: watcher.quietMs, baselineMs})

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
      launch(source.id, () => processMention(watcher, source.id, source.deepLink, baselineMs, launchStamp))
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
      const result = await runTask(runOptionsFor(watcher, prompt))
      if (result.ok) {
        log(`[${watcher.name}] done: ${truncate(result.resultText.trim(), 200)}`)
      } else {
        log(`[${watcher.name}] FAILED: exit ${result.exitCode} ${truncate(result.stderr.trim())}`)
      }
    })
  }

  const tick = async () => {
    if (!launchTimesLoaded) {
      launchTimes = await state.getLaunchTimes()
      pruneLaunchTimes()
      launchTimesLoaded = true
    }
    for (const watcher of config.watchers) {
      try {
        if (watcher.kind === 'backlinks') await tickBacklinksWatcher(watcher)
        else await tickQueryWatcher(watcher)
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
