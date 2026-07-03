/**
 * watch-events facility — the DETECTION half of graph watchers, living
 * where the data layer is reactive instead of being re-derived by
 * polling from outside the process.
 *
 * External consumers (the claude-tasks daemon, other bridge clients)
 * register named watchers over the bridge (`watch-events` command); each
 * watcher re-runs a read-only query when its tables change and, once the
 * result set has been stable for `settleMs`, pushes a small
 * `watcher-settled` event through the bridge events channel. Events are
 * HINTS, not truth: consumers re-derive state from the graph on every
 * hint, so a dropped/duplicate event costs nothing — which is what lets
 * registrations be ephemeral (they die with the tab and expire without a
 * TTL refresh) while consumers keep a slow poll as backstop.
 */
import type { PowerSyncDb } from '@/data/internals/commitPipeline'
import type { WatchEventsWatcher } from '@knowledge-medium/agent-cli/protocol'

export type WatchEventTransport = (event: Record<string, unknown>) => Promise<void>

export interface WatchEventsRegistration {
  consumer: string
  watchers: WatchEventsWatcher[]
  ttlMs?: number
}

export interface WatchEventsResult {
  consumer: string
  registered: string[]
  /** True when the spec matched the existing registration — state
   *  (fingerprints, settle timers) was kept, only the TTL refreshed. */
  unchanged: boolean
}

const DEFAULT_SETTLE_MS = 1_000
const DEFAULT_TTL_MS = 10 * 60_000
/** Collapse change bursts before re-running the watcher query. */
const CHANGE_THROTTLE_MS = 250

/** Backlink watchers get a canned query so consumers never hand-roll
 *  reference-table SQL: any edit to (or arrival/removal of) a block
 *  referencing the target changes the fingerprint. */
const BACKLINKS_WATCH_SQL = `
  SELECT br.source_id AS id, coalesce(b.user_updated_at, b.updated_at) AS edited_at
    FROM block_references br JOIN blocks b ON b.id = br.source_id
   WHERE br.target_id = ? AND b.deleted = 0
   ORDER BY br.source_id`
const BACKLINKS_WATCH_TABLES = ['blocks', 'block_references']

interface WatcherRuntime {
  name: string
  sql: string
  params: unknown[]
  settleMs: number
  /** JSON of the last result set; null until the baseline run. */
  fingerprint: string | null
  settleTimer: ReturnType<typeof setTimeout> | null
  computing: boolean
  recheck: boolean
  disposeOnChange: (() => void) | null
}

interface ConsumerEntry {
  specJson: string
  ttlMs: number
  lastRefreshedMs: number
  runtimes: WatcherRuntime[]
}

const watcherRuntimeFor = (spec: WatchEventsWatcher): WatcherRuntime => ({
  name: spec.name,
  sql: spec.kind === 'backlinks' ? BACKLINKS_WATCH_SQL : spec.sql,
  params: spec.kind === 'backlinks' ? [spec.targetId] : (spec.params ?? []),
  settleMs: spec.settleMs ?? DEFAULT_SETTLE_MS,
  fingerprint: null,
  settleTimer: null,
  computing: false,
  recheck: false,
  disposeOnChange: null,
})

const watchTablesFor = (spec: WatchEventsWatcher): string[] =>
  spec.kind === 'backlinks' ? BACKLINKS_WATCH_TABLES : (spec.tables ?? ['blocks'])

export const createWatchEventsRegistry = (now: () => number = Date.now) => {
  const entries = new Map<string, ConsumerEntry>()
  // The transport is owned by the bridge loop (it knows the live bridge
  // URL, secret, and clientId) and injected here so this module stays
  // free of HTTP concerns. Null = no bridge running = events dropped.
  let transport: WatchEventTransport | null = null

  const setTransport = (next: WatchEventTransport | null) => {
    transport = next
  }

  const emitSettled = (consumer: string, runtime: WatcherRuntime) => {
    const send = transport
    if (!send) return
    void send({type: 'watcher-settled', consumer, watcher: runtime.name}).catch(error => {
      console.warn(`watch-events: failed to push ${consumer}/${runtime.name} event`, error)
    })
  }

  const disposeRuntime = (runtime: WatcherRuntime) => {
    runtime.disposeOnChange?.()
    runtime.disposeOnChange = null
    if (runtime.settleTimer !== null) clearTimeout(runtime.settleTimer)
    runtime.settleTimer = null
  }

  const disposeConsumer = (consumer: string) => {
    const entry = entries.get(consumer)
    if (!entry) return
    for (const runtime of entry.runtimes) disposeRuntime(runtime)
    entries.delete(consumer)
  }

  const armSettle = (consumer: string, runtime: WatcherRuntime) => {
    if (runtime.settleTimer !== null) clearTimeout(runtime.settleTimer)
    runtime.settleTimer = setTimeout(() => {
      runtime.settleTimer = null
      emitSettled(consumer, runtime)
    }, runtime.settleMs)
  }

  const computeLoop = async (db: PowerSyncDb, consumer: string, runtime: WatcherRuntime) => {
    runtime.computing = true
    try {
      do {
        runtime.recheck = false
        const rows = await db.getAll(runtime.sql, runtime.params)
        const fingerprint = JSON.stringify(rows)
        if (runtime.fingerprint !== null && fingerprint !== runtime.fingerprint) {
          // Every change RE-arms the timer, so the event fires settleMs
          // after the LAST change — quiet-period semantics, detected at
          // the source instead of guessed by a poller.
          armSettle(consumer, runtime)
        }
        runtime.fingerprint = fingerprint
      } while (runtime.recheck)
    } finally {
      runtime.computing = false
    }
  }

  const requestCompute = (db: PowerSyncDb, consumer: string, runtime: WatcherRuntime) => {
    const entry = entries.get(consumer)
    if (!entry) return
    // Expired registrations self-clean on their next signal — a dead
    // consumer must not keep the tab re-running queries forever.
    if (now() - entry.lastRefreshedMs > entry.ttlMs) {
      disposeConsumer(consumer)
      return
    }
    if (runtime.computing) {
      runtime.recheck = true
      return
    }
    void computeLoop(db, consumer, runtime).catch(error => {
      console.warn(`watch-events: ${consumer}/${runtime.name} query failed`, error)
    })
  }

  /** Replace `consumer`'s registration. Idempotent: an identical spec
   *  only refreshes the TTL, preserving fingerprints and settle timers
   *  (a periodic re-register must not swallow a pending event). Resolves
   *  after the baseline query of every NEW watcher, so a successful
   *  response means the watchers are armed. */
  const register = async (db: PowerSyncDb, registration: WatchEventsRegistration): Promise<WatchEventsResult> => {
    const {consumer, watchers} = registration
    const ttlMs = registration.ttlMs ?? DEFAULT_TTL_MS
    const specJson = JSON.stringify({watchers, ttlMs})

    const existing = entries.get(consumer)
    if (existing && existing.specJson === specJson) {
      existing.lastRefreshedMs = now()
      return {consumer, registered: existing.runtimes.map(runtime => runtime.name), unchanged: true}
    }

    disposeConsumer(consumer)
    if (watchers.length === 0) return {consumer, registered: [], unchanged: false}

    const entry: ConsumerEntry = {
      specJson,
      ttlMs,
      lastRefreshedMs: now(),
      runtimes: watchers.map(watcherRuntimeFor),
    }
    entries.set(consumer, entry)

    try {
      // Baseline before subscribing: the current result set must never
      // fire (mirrors the daemon's own first-tick baseline).
      await Promise.all(entry.runtimes.map(runtime => computeLoop(db, consumer, runtime)))
    } catch (error) {
      disposeConsumer(consumer)
      throw error
    }

    watchers.forEach((spec, index) => {
      const runtime = entry.runtimes[index]!
      runtime.disposeOnChange = db.onChange(
        {
          onChange: () => requestCompute(db, consumer, runtime),
          onError: error => console.warn(`watch-events: ${consumer}/${runtime.name} subscription error`, error),
        },
        {tables: watchTablesFor(spec), throttleMs: CHANGE_THROTTLE_MS},
      )
    })

    return {consumer, registered: entry.runtimes.map(runtime => runtime.name), unchanged: false}
  }

  const disposeAll = () => {
    for (const consumer of [...entries.keys()]) disposeConsumer(consumer)
  }

  return {register, setTransport, disposeAll}
}

export type WatchEventsRegistry = ReturnType<typeof createWatchEventsRegistry>

/** The app-wide instance: commands.ts registers into it, bridge.ts owns
 *  its transport lifecycle. */
export const watchEventsRegistry = createWatchEventsRegistry()
