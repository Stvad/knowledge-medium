/**
 * Push loop — the daemon's consumer side of the in-tab watch-events
 * facility. Registers the config's watchers with the tab (detection
 * runs where the data layer is reactive), long-polls the bridge events
 * channel, and turns every settle event into an immediate engine tick.
 *
 * Events are ACCELERATORS, not truth: the tick re-derives everything
 * from graph state (status props, baselines, cursors), so duplicate,
 * missed, or spurious events cost at most one cheap tick — the polling
 * sweep in daemon.ts remains the correctness backstop. That's what
 * keeps this loop allowed to fail: any error just degrades to sweep
 * latency, never to missed work.
 */
import { errorMessage, type BridgeClient } from '@knowledge-medium/agent-cli/client'
import type { WatchEventsWatcher } from '@knowledge-medium/agent-cli/protocol'
import type { DaemonConfig } from './config.js'
import type { Graph } from './graph.js'

export const PUSH_CONSUMER = 'claude-tasks'

/** Tab-side registrations expire without a refresh (a dead daemon must
 *  not leave watchers running forever); refresh at half the TTL so one
 *  missed cycle doesn't lapse the registration. */
export const REGISTRATION_TTL_MS = 10 * 60_000
export const REGISTRATION_REFRESH_MS = REGISTRATION_TTL_MS / 2

/** Settle window for query watchers: no user-typing semantics to wait
 *  out (rows appear atomically), just burst-coalescing. */
const QUERY_SETTLE_MS = 1_000

const EVENTS_TIMEOUT_MS = 25_000
const ERROR_BACKOFF_MS = 15_000
/** An old tab bundle rejects the watch-events command outright, and a
 *  read-only-scoped token can never register — retrying fast can't fix
 *  either; retry slowly (a reload/re-pair may). */
const UNSUPPORTED_BACKOFF_MS = 5 * 60_000

/** Exemptions ride only FRESH events. A replayed/delayed event (error
 *  backoff + ring-buffer catch-up) may describe a quiet the user has
 *  since broken by re-entering the block — stale settledBlocks degrade
 *  to a plain (un-exempted) tick. Bridge and daemon share the machine
 *  clock, so receivedAt is directly comparable. */
export const MAX_EXEMPTION_AGE_MS = 10_000

/** Per-watcher quiet exemptions from one batch of events. Keyed by the
 *  EMITTING watcher: a query watcher's 1s settle must not vouch for a
 *  backlinks watcher's much longer quietMs on the same block. */
export type QuietExemptions = ReadonlyMap<string, ReadonlySet<string>>

/** Cap on pooled exemption ids — a settledBlocks flood degrades to
 *  un-exempted ticks (sweep-latency cost), never to unbounded memory. */
export const MAX_PENDING_EXEMPT_IDS = 2_048
/** Exemptions expire in the pool too: ticks drain the pool, but a sick
 *  bridge can stall a tick for minutes (each graph call may hang up to
 *  the client timeout) — by then "quiet, source-confirmed" may be
 *  false again, so drained exemptions older than this are dropped. */
export const EXEMPTION_POOL_TTL_MS = 10_000

/** Daemon-side pool between push events and the (coalesced) tick that
 *  consumes them: per-watcher, deduped, bounded, and freshness-checked
 *  AT DRAIN TIME — arrival-time freshness alone (see the event loop
 *  below) doesn't cover a delayed drain. */
export const createExemptionPool = (now: () => number = Date.now) => {
  const pools = new Map<string, Map<string, number>>() // watcher → id → pooledAt
  let count = 0

  const add = (exemptions: QuietExemptions): void => {
    for (const [watcher, ids] of exemptions) {
      const pool = pools.get(watcher) ?? new Map<string, number>()
      for (const id of ids) {
        if (count >= MAX_PENDING_EXEMPT_IDS) break
        if (!pool.has(id)) {
          pool.set(id, now())
          count += 1
        }
      }
      if (pool.size > 0) pools.set(watcher, pool)
    }
  }

  const drain = (): Map<string, ReadonlySet<string>> => {
    const cutoff = now() - EXEMPTION_POOL_TTL_MS
    const result = new Map<string, ReadonlySet<string>>()
    for (const [watcher, pool] of pools) {
      const fresh = new Set<string>()
      for (const [id, pooledAt] of pool) {
        if (pooledAt >= cutoff) fresh.add(id)
      }
      if (fresh.size > 0) result.set(watcher, fresh)
    }
    pools.clear()
    count = 0
    return result
  }

  return {add, drain}
}

export interface PushDeps {
  client: Pick<BridgeClient, 'runCommand' | 'nextEvents'>
  config: DaemonConfig
  graph: Pick<Graph, 'resolvePageId'>
  /** Ask the main loop for an immediate tick (coalesced there).
   *  `exemptions` are quiet-exempt block ids per emitting watcher:
   *  their quiet period was confirmed at the source (blur / settle). */
  requestTick: (exemptions?: QuietExemptions) => void
  log: (message: string) => void
  isStopping: () => boolean
  /** Interruptible sleep (resolves early on shutdown). */
  nap: (ms: number) => Promise<void>
  /** Aborts in-flight long-polls on shutdown. */
  stopSignal?: AbortSignal
  now?: () => number
}

const isPermanentRejection = (error: unknown): boolean => {
  const message = errorMessage(error)
  return message.includes('Unknown agent runtime command') // old tab bundle
    || message.includes('Invalid command body') // schema mismatch (old bundle / bad config)
    || message.includes('Token scope') // read-only token can't register watchers
}

export const buildRegistrationWatchers = async (
  config: DaemonConfig,
  graph: Pick<Graph, 'resolvePageId'>,
): Promise<WatchEventsWatcher[]> =>
  Promise.all(config.watchers.map(async (watcher): Promise<WatchEventsWatcher> =>
    watcher.kind === 'backlinks'
      ? {
          kind: 'backlinks',
          name: watcher.name,
          targetId: await graph.resolvePageId(watcher.target),
          // The tab measures the quiet period at the source, so by the
          // time the event lands the engine's own quiet gate passes.
          settleMs: watcher.quietMs,
        }
      : {
          kind: 'sql',
          name: watcher.name,
          sql: watcher.sql,
          params: watcher.params,
          tables: watcher.tables,
          settleMs: QUERY_SETTLE_MS,
        },
  ))

export const startPushLoop = async (deps: PushDeps): Promise<void> => {
  const {client, config, graph, requestTick, log, isStopping, nap, stopSignal} = deps
  const now = deps.now ?? Date.now

  let cursor: number | null = null
  // null = not registered (never, or invalidated by an error/reset) —
  // NOT epoch 0, which would make first registration depend on the size
  // of the clock value.
  let registeredAt: number | null = null
  let announced = false

  while (!isStopping()) {
    try {
      if (registeredAt === null || now() - registeredAt >= REGISTRATION_REFRESH_MS) {
        const watchers = await buildRegistrationWatchers(config, graph)
        await client.runCommand({
          type: 'watch-events',
          consumer: PUSH_CONSUMER,
          watchers,
          ttlMs: REGISTRATION_TTL_MS,
        })
        registeredAt = now()
        if (!announced) {
          announced = true
          log(`push: watch-events registered (${watchers.map(watcher => watcher.name).join(', ')}) — events beat the ${config.pollIntervalMs}ms sweep`)
        }
      }

      const response = await client.nextEvents({
        afterSeq: cursor,
        timeoutMs: EVENTS_TIMEOUT_MS,
        signal: stopSignal,
      })
      cursor = response.nextSeq
      if (response.reset) {
        // Bridge restarted: registration state is gone too, and unknown
        // events may have been dropped — re-register and sweep once.
        registeredAt = null
        log('push: bridge restarted — re-registering and sweeping')
        requestTick()
        continue
      }
      const relevant = response.events.filter(entry =>
        entry.event['type'] === 'watcher-settled' && entry.event['consumer'] === PUSH_CONSUMER)
      if (relevant.length > 0) {
        const exemptions = new Map<string, Set<string>>()
        for (const entry of relevant) {
          const watcher = entry.event['watcher']
          const blocks = entry.event['settledBlocks']
          if (typeof watcher !== 'string' || !Array.isArray(blocks)) continue
          if (now() - entry.receivedAt > MAX_EXEMPTION_AGE_MS) continue // stale: tick, but don't exempt
          const ids = exemptions.get(watcher) ?? new Set<string>()
          for (const id of blocks) if (typeof id === 'string') ids.add(id)
          if (ids.size > 0) exemptions.set(watcher, ids)
        }
        requestTick(exemptions)
      }
    } catch (error) {
      if (isStopping()) return
      registeredAt = null // whatever broke, re-register once it heals
      if (isPermanentRejection(error)) {
        log(`push: tab/bridge rejected watch-events (${errorMessage(error)}) — polling only; retrying in ${UNSUPPORTED_BACKOFF_MS / 60_000}min`)
        await nap(UNSUPPORTED_BACKOFF_MS)
      } else {
        log(`push: ${errorMessage(error)} — retrying in ${ERROR_BACKOFF_MS / 1000}s`)
        await nap(ERROR_BACKOFF_MS)
      }
    }
  }
}
