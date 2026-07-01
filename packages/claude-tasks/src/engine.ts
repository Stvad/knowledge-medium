/**
 * Orchestration: one `tick()` scans all watchers, claims pending work,
 * and launches bounded-concurrency Claude runs. Pure wiring — every
 * decision lives in watchers.ts, every side effect behind an injected
 * dependency, so the whole flow is testable with in-memory fakes.
 */
import os from 'node:os'
import { renderSubtreeOutline, type SubtreeOutlineRow } from '@knowledge-medium/agent-cli/subtreeOutline'
import type { BacklinksWatcher, DaemonConfig, QueryWatcher, Watcher } from './config.js'
import type { Graph } from './graph.js'
import type { ClaudeRunOptions, ClaudeRunResult } from './runner.js'
import type { StateStore } from './state.js'
import { decidePending, diffQueryRows, findThreadSession } from './watchers.js'
import { renderMentionPrompt, renderQueryPrompt } from './prompt.js'
import { KM_MCP_ALLOWED_TOOLS } from './mcpShared.js'

export interface EngineDeps {
  config: DaemonConfig
  graph: Graph
  state: StateStore
  runTask: (options: ClaudeRunOptions) => Promise<ClaudeRunResult>
  /** Generated --mcp-config path; null disables graph tools for runs. */
  mcpConfigPath: string | null
  log: (message: string) => void
  now?: () => number
}

const truncate = (value: string, max = 500): string =>
  value.length > max ? `${value.slice(0, max)}…` : value

export const createEngine = (deps: EngineDeps) => {
  const {config, graph, state, runTask, mcpConfigPath, log} = deps
  const now = deps.now ?? Date.now

  /** Block ids (mention tasks) / watcher names (query batches) with a
   *  live run. Guards double-claim across overlapping ticks. */
  const inFlight = new Set<string>()
  const running = new Set<Promise<void>>()
  const pageIdCache = new Map<string, string>()

  const capacityLeft = () => config.maxConcurrent - inFlight.size

  const launch = (key: string, work: () => Promise<void>) => {
    inFlight.add(key)
    const promise = work()
      .catch(error => log(`[${key}] run crashed: ${error instanceof Error ? error.message : String(error)}`))
      .finally(() => {
        inFlight.delete(key)
        running.delete(promise)
      })
    running.add(promise)
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

  const processMention = async (watcher: BacklinksWatcher, sourceId: string, deepLink: string) => {
    const block = await graph.getBlock(sourceId)
    if (!block) return
    const ancestorBlocks = await graph.ancestors(sourceId)
    const decision = decidePending({source: block, ancestors: ancestorBlocks, nowMs: now()})
    if (!decision.pending) return

    log(`[${watcher.name}] claiming ${sourceId} (${decision.reason})`)
    await graph.setTaskProps(sourceId, {status: 'running', watcher: watcher.name, nowMs: now()})

    try {
      const subtreeRows = await graph.getSubtree(sourceId)
      const prompt = renderMentionPrompt(watcher.prompt, {
        content: block.content ?? '',
        subtree: renderSubtreeOutline(subtreeRows as SubtreeOutlineRow[]),
        // graph.ancestors is nearest-first; the prompt reads root→leaf.
        ancestors: ancestorBlocks.map(ancestor => ancestor.content ?? '').reverse(),
        blockId: sourceId,
        deepLink,
        watcherName: watcher.name,
      })
      const session = watcher.resume ? findThreadSession(block, ancestorBlocks) : null

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
      const reason = truncate(error instanceof Error ? error.message : String(error))
      await graph.setTaskProps(sourceId, {status: 'error', error: reason, nowMs: now()}).catch(() => {})
      throw error
    }
  }

  const tickBacklinksWatcher = async (watcher: BacklinksWatcher) => {
    let targetId = pageIdCache.get(watcher.target)
    if (!targetId) {
      targetId = await graph.resolvePageId(watcher.target)
      pageIdCache.set(watcher.target, targetId)
    }

    const sources = await graph.backlinkSources(targetId)
    if (sources.length === 0) return

    // Cheap pre-filter (one batched query): already-processed mentions
    // must not consume launch slots or per-block round-trips. Source-only
    // decision here — the ancestor-dependent checks re-run with full
    // context inside processMention before anything is claimed.
    const props = await graph.blockProps(sources.map(source => source.id))
    for (const source of sources) {
      if (capacityLeft() <= 0) return
      if (inFlight.has(source.id)) continue
      const preview = decidePending({
        source: {id: source.id, properties: props.get(source.id) ?? {}},
        ancestors: [],
        nowMs: now(),
      })
      if (!preview.pending) continue
      launch(source.id, () => processMention(watcher, source.id, source.deepLink))
    }
  }

  const tickQueryWatcher = async (watcher: QueryWatcher) => {
    const key = `query:${watcher.name}`
    if (inFlight.has(key)) return

    const rows = await graph.sqlAll(watcher.sql, watcher.params)
    const prev = await state.getCursor(watcher.name)
    const diff = diffQueryRows(rows, prev)
    if (diff.invalidRows > 0) {
      log(`[${watcher.name}] skipped ${diff.invalidRows} row(s) without a string id — the watcher SQL must select an id column`)
    }

    if (prev === null) {
      await state.setCursor(watcher.name, diff.seenIds)
      log(`[${watcher.name}] baseline established (${diff.seenIds.length} rows) — future rows will trigger`)
      return
    }
    if (diff.newRows.length === 0) return
    if (capacityLeft() <= 0) return

    // Claim-at-cursor: advance before the run so a persistently failing
    // prompt can't re-fire (and re-bill) every tick. Failures are logged.
    await state.setCursor(watcher.name, diff.seenIds)
    const prompt = renderQueryPrompt(watcher.prompt, {newRows: diff.newRows, watcherName: watcher.name})

    log(`[${watcher.name}] firing for ${diff.newRows.length} new row(s)`)
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
    for (const watcher of config.watchers) {
      try {
        if (watcher.kind === 'backlinks') await tickBacklinksWatcher(watcher)
        else await tickQueryWatcher(watcher)
      } catch (error) {
        log(`[${watcher.name}] tick failed: ${error instanceof Error ? error.message : String(error)}`)
      }
    }
  }

  /** Await all launched runs — shutdown + tests. */
  const drain = async () => {
    while (running.size > 0) await Promise.allSettled([...running])
  }

  return {tick, drain, inFlight}
}

export type Engine = ReturnType<typeof createEngine>
