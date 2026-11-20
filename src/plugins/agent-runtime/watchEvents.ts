/**
 * watch-events facility — the DETECTION half of graph watchers, living
 * where the data layer is reactive instead of being re-derived by
 * polling from outside the process.
 *
 * External consumers (the agent-dispatch daemon, other bridge clients)
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
import { BEING_EDITED_BLOCKS_SQL, type WatchEventsWatcher } from '@knowledge-medium/agent-cli/protocol'

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
 *  referencing the target changes the fingerprint, and so does the block
 *  entering or leaving an editor on any client, which is what releases a
 *  mention the consumer is holding. */
export const BACKLINKS_WATCH_SQL = `
  SELECT br.source_id AS id,
         coalesce(b.user_updated_at, b.updated_at) AS edited_at,
         br.source_id IN (SELECT id FROM (${BEING_EDITED_BLOCKS_SQL})) AS being_edited
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
  /** A change signal arrived that no compute has consumed yet. Makes an
   *  in-progress computeLoop re-iterate. */
  pendingChange: boolean
  /** Set on dispose. In-flight computeLoops / armed timers hold direct
   *  runtime references across awaits; once disposed nothing observes
   *  changes anymore, so acting on the stale reference would emit
   *  "settled" for a block that may still be mid-edit. */
  disposed: boolean
  disposeOnChange: (() => void) | null
}

interface ConsumerEntry {
  specJson: string
  ttlMs: number
  lastRefreshedMs: number
  runtimes: WatcherRuntime[]
  /** Settles when the registration finished arming (baseline + change
   *  subscriptions); rejects if it died first (baseline failure, a
   *  replacement registration superseding it, or any dispose). An
   *  identical-spec re-register must not report success against an
   *  entry that is still baselining — the entry may yet die, leaving
   *  the consumer believing it's registered for a whole refresh
   *  interval. */
  ready: Promise<void>
  /** Settle `ready` as failed — dispose paths call this so retries
   *  parked on `ready` wake instead of pending forever. Idempotent. */
  rejectReady: (error: unknown) => void
}

const watcherRuntimeFor = (spec: WatchEventsWatcher): WatcherRuntime => ({
  name: spec.name,
  sql: spec.kind === 'backlinks' ? BACKLINKS_WATCH_SQL : spec.sql,
  params: spec.kind === 'backlinks' ? [spec.targetId] : (spec.params ?? []),
  settleMs: spec.settleMs ?? DEFAULT_SETTLE_MS,
  fingerprint: null,
  settleTimer: null,
  computing: false,
  pendingChange: false,
  disposed: false,
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
  // False between disposeAll (bridge teardown) and the next bridge
  // start. Commands already executing in the tab are NOT cancelled by
  // teardown, so a register woken mid-flight (its parked `ready`
  // rejected by disposeAll) could otherwise re-arm live watchers that
  // no bridge owns — burning queries with no transport for a full TTL.
  let active = true

  const setTransport = (next: WatchEventTransport | null) => {
    transport = next
    if (next) active = true
  }

  const assertActive = () => {
    if (!active) throw new Error('watch-events registry stopped (bridge torn down)')
  }

  const emitSettled = (consumer: string, runtime: WatcherRuntime) => {
    if (runtime.disposed) return
    const send = transport
    if (!send) return
    void send({type: 'watcher-settled', consumer, watcher: runtime.name}).catch(error => {
      console.warn(`watch-events: failed to push ${consumer}/${runtime.name} event`, error)
    })
  }

  const disposeRuntime = (runtime: WatcherRuntime) => {
    runtime.disposed = true
    runtime.disposeOnChange?.()
    runtime.disposeOnChange = null
    if (runtime.settleTimer !== null) clearTimeout(runtime.settleTimer)
    runtime.settleTimer = null
  }

  /** Dispose a SPECIFIC entry — it may already have been replaced in
   *  `entries` by a newer registration, which must survive untouched.
   *  Dispose is the settlement authority for `ready`: an entry that
   *  dies while baselining (TTL prune, disposeAll, replacement) must
   *  not leave identical-spec retries parked on it forever. */
  const disposeEntry = (consumer: string, entry: ConsumerEntry) => {
    for (const runtime of entry.runtimes) disposeRuntime(runtime)
    if (entries.get(consumer) === entry) entries.delete(consumer)
    entry.rejectReady(new Error('watch-events registration disposed'))
  }

  const disposeConsumer = (consumer: string) => {
    const entry = entries.get(consumer)
    if (entry) disposeEntry(consumer, entry)
  }

  const armSettle = (consumer: string, runtime: WatcherRuntime) => {
    if (runtime.disposed) return
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
        runtime.pendingChange = false
        const rows = await db.getAll(runtime.sql, runtime.params)
        // Disposed while the query was in flight (registration replaced,
        // TTL expiry): this runtime no longer observes changes, so any
        // settle it armed would be a false "quiet" confirmation.
        if (runtime.disposed) return
        const fingerprint = JSON.stringify(rows)
        // Every change RE-arms the timer, so the event fires settleMs
        // after the LAST change — quiet-period semantics, detected at
        // the source instead of guessed by a poller.
        if (runtime.fingerprint !== null && fingerprint !== runtime.fingerprint) {
          armSettle(consumer, runtime)
        }
        runtime.fingerprint = fingerprint
      } while (runtime.pendingChange)
    } finally {
      runtime.computing = false
    }
  }

  /** Expired registrations self-clean on their next signal — a dead
   *  consumer must not keep the tab re-running queries forever. */
  const pruneIfExpired = (consumer: string, entry: ConsumerEntry): boolean => {
    if (now() - entry.lastRefreshedMs <= entry.ttlMs) return false
    disposeEntry(consumer, entry)
    return true
  }

  const requestCompute = (db: PowerSyncDb, consumer: string, runtime: WatcherRuntime) => {
    if (runtime.disposed) return
    runtime.pendingChange = true
    const entry = entries.get(consumer)
    // Only the runtime's OWN entry may vouch for its freshness — after a
    // replace-registration, `entries` holds the successor's entry.
    if (!entry || !entry.runtimes.includes(runtime)) return
    if (pruneIfExpired(consumer, entry)) return
    // An in-progress computeLoop re-iterates on pendingChange.
    if (runtime.computing) return
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
    assertActive()
    const {consumer, watchers} = registration
    const ttlMs = registration.ttlMs ?? DEFAULT_TTL_MS
    const specJson = JSON.stringify({watchers, ttlMs})

    const existing = entries.get(consumer)
    if (existing && existing.specJson === specJson) {
      existing.lastRefreshedMs = now()
      try {
        // A concurrent identical registration (daemon retry after a
        // client-side timeout) may still be baselining — only confirm
        // once it actually armed. If it died, fall through and
        // register fresh instead of vouching for a dead entry.
        await existing.ready
        // Ownership can change during the await even when ready
        // resolved: a different-spec registration may have replaced
        // the entry. Only vouch for an entry that is still live.
        if (entries.get(consumer) === existing) {
          return {consumer, registered: existing.runtimes.map(runtime => runtime.name), unchanged: true}
        }
      } catch {
        /* the entry died mid-arming */
      }
      // Our identical-spec entry died or was replaced while we waited.
      // If a DIFFERENT registration now owns the consumer, it is newer
      // by causality (it replaced ours) — defer to it rather than
      // clobbering a healthy successor with this (older) retry.
      const current = entries.get(consumer)
      if (current && current !== existing) {
        return {consumer, registered: [], unchanged: false}
      }
      // The wake-up may have BEEN the teardown (disposeAll rejects
      // `ready`) — registering fresh here would resurrect watchers
      // after the bridge died.
      assertActive()
    }

    disposeConsumer(consumer)
    if (watchers.length === 0) return {consumer, registered: [], unchanged: false}

    let readyResolve!: () => void
    let readyReject!: (error: unknown) => void
    const ready = new Promise<void>((resolve, reject) => {
      readyResolve = resolve
      readyReject = reject
    })
    // Only identical-spec re-registers await `ready`; without one, the
    // rejection must not surface as an unhandled-promise crash.
    ready.catch(() => {})

    const entry: ConsumerEntry = {
      specJson,
      ttlMs,
      lastRefreshedMs: now(),
      runtimes: watchers.map(watcherRuntimeFor),
      ready,
      rejectReady: readyReject,
    }
    entries.set(consumer, entry)

    try {
      // Baseline before subscribing: the current result set must never
      // fire (mirrors the daemon's own first-tick baseline).
      await Promise.all(entry.runtimes.map(runtime => computeLoop(db, consumer, runtime)))
    } catch (error) {
      disposeEntry(consumer, entry) // also rejects `ready`
      throw error
    }

    // Commands run concurrently in the tab: a second registration for
    // this consumer may have replaced ours while we baselined — or the
    // whole registry was torn down. The successor owns the consumer —
    // subscribing our runtimes anyway would leave live watchers no
    // dispose path can ever reach.
    if (!active || entries.get(consumer) !== entry) {
      disposeEntry(consumer, entry) // also rejects `ready`
      assertActive() // teardown: fail the command so the daemon retries later
      return {consumer, registered: [], unchanged: false}
    }

    watchers.forEach((spec, index) => {
      const runtime = entry.runtimes[index]!
      runtime.disposeOnChange = db.onChange(
        {onChange: () => requestCompute(db, consumer, runtime)},
        {tables: watchTablesFor(spec), throttleMs: CHANGE_THROTTLE_MS},
      )
    })

    readyResolve()
    return {consumer, registered: entry.runtimes.map(runtime => runtime.name), unchanged: false}
  }

  const disposeAll = () => {
    active = false // until the next bridge start (setTransport)
    for (const consumer of [...entries.keys()]) disposeConsumer(consumer)
  }

  return {register, setTransport, disposeAll}
}

export type WatchEventsRegistry = ReturnType<typeof createWatchEventsRegistry>

/** The app-wide instance: commands.ts registers into it, bridge.ts owns
 *  its transport lifecycle. */
export const watchEventsRegistry = createWatchEventsRegistry()
