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
/** How long a blur (notifyBlockSettled) keeps its block quiet-exempt in
 *  flush emits — covers the editor's debounced content commit plus the
 *  recheck below. */
const BLUR_EXEMPT_MS = 2_500
/** Second look after a blur: the editor flushes its debounced commit on
 *  unmount, so the write may land shortly AFTER the blur signal. */
const BLUR_RECHECK_MS = 600
/** Bound on settledBlocks per event — a mass change (import, sync burst)
 *  degrades to an un-exempted tick, not an unbounded payload. */
const MAX_SETTLED_IDS = 128

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
  /** id → row-JSON as of the last EMIT (or baseline) — the reference
   *  point for which ids an emit reports as settled. */
  lastEmittedById: Map<string, string>
  /** id → row-JSON as of the last COMPUTE. */
  currentById: Map<string, string>
  /** Ids that changed since the last emit. */
  pendingSettledIds: Set<string>
  settleTimer: ReturnType<typeof setTimeout> | null
  computing: boolean
  recheck: boolean
  /** A change signal arrived that no compute has consumed yet — the only
   *  case where a blur flush needs to re-run the query itself. */
  dirty: boolean
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
  db: PowerSyncDb
  runtimes: WatcherRuntime[]
}

const watcherRuntimeFor = (spec: WatchEventsWatcher): WatcherRuntime => ({
  name: spec.name,
  sql: spec.kind === 'backlinks' ? BACKLINKS_WATCH_SQL : spec.sql,
  params: spec.kind === 'backlinks' ? [spec.targetId] : (spec.params ?? []),
  settleMs: spec.settleMs ?? DEFAULT_SETTLE_MS,
  fingerprint: null,
  lastEmittedById: new Map(),
  currentById: new Map(),
  pendingSettledIds: new Set(),
  settleTimer: null,
  computing: false,
  recheck: false,
  dirty: false,
  disposed: false,
  disposeOnChange: null,
})

/** One serialization pass serves both the change fingerprint and the
 *  per-id diff state — this runs on every (throttled) table change.
 *  The joined fingerprint is byte-identical to JSON.stringify(rows)
 *  and is only ever compared to itself. */
const serializeRows = (rows: unknown[]): {fingerprint: string, byId: Map<string, string>} => {
  const byId = new Map<string, string>()
  const rowJsons: string[] = []
  for (const row of rows) {
    const json = JSON.stringify(row) ?? 'null' // array-position semantics for non-serializable rows
    rowJsons.push(json)
    const id = (row as {id?: unknown} | null)?.id
    if (typeof id === 'string' && id) byId.set(id, json)
  }
  return {fingerprint: `[${rowJsons.join(',')}]`, byId}
}

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

  /** blockId → exempt-until. Blocks the user explicitly left (blur /
   *  action) — the only ids a flush emit may report as settled. */
  const blurredUntil = new Map<string, number>()
  const isBlurredNow = (blockId: string): boolean => {
    const until = blurredUntil.get(blockId)
    if (until === undefined) return false
    if (now() > until) {
      blurredUntil.delete(blockId)
      return false
    }
    return true
  }

  /** Emit the watcher's event and advance its emitted-state reference.
   *  `timeConfirmed` (settle timer ran its full course) may report every
   *  pending id as settled; a blur FLUSH may only report ids whose
   *  quiet the user confirmed by leaving them — a concurrently-syncing
   *  edit from another device must not ride the exemption. */
  const emitSettled = (consumer: string, runtime: WatcherRuntime, timeConfirmed: boolean) => {
    if (runtime.disposed) return
    const settled = [...runtime.pendingSettledIds]
      .filter(id => timeConfirmed || isBlurredNow(id))
      .slice(0, MAX_SETTLED_IDS)

    if (timeConfirmed) {
      runtime.pendingSettledIds.clear()
      runtime.lastEmittedById = new Map(runtime.currentById)
    } else {
      for (const id of settled) {
        runtime.pendingSettledIds.delete(id)
        const current = runtime.currentById.get(id)
        if (current === undefined) runtime.lastEmittedById.delete(id)
        else runtime.lastEmittedById.set(id, current)
      }
    }

    const send = transport
    if (!send) return
    void send({
      type: 'watcher-settled',
      consumer,
      watcher: runtime.name,
      ...(settled.length > 0 ? {settledBlocks: settled} : {}),
    }).catch(error => {
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
   *  `entries` by a newer registration, which must survive untouched. */
  const disposeEntry = (consumer: string, entry: ConsumerEntry) => {
    for (const runtime of entry.runtimes) disposeRuntime(runtime)
    if (entries.get(consumer) === entry) entries.delete(consumer)
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
      emitSettled(consumer, runtime, true)
    }, runtime.settleMs)
  }

  const computeLoop = async (db: PowerSyncDb, consumer: string, runtime: WatcherRuntime) => {
    runtime.computing = true
    try {
      do {
        runtime.recheck = false
        runtime.dirty = false
        const rows = await db.getAll(runtime.sql, runtime.params)
        // Disposed while the query was in flight (registration replaced,
        // TTL expiry): this runtime no longer observes changes, so any
        // settle it armed would be a false "quiet" confirmation.
        if (runtime.disposed) return
        const {fingerprint, byId} = serializeRows(rows)
        runtime.currentById = byId
        if (runtime.fingerprint !== null && fingerprint !== runtime.fingerprint) {
          // Record which ids drifted from the last-emitted state — they
          // become the event's settledBlocks (quiet-exemption hints).
          for (const [id, json] of runtime.currentById) {
            if (runtime.lastEmittedById.get(id) !== json) runtime.pendingSettledIds.add(id)
          }
          for (const id of runtime.lastEmittedById.keys()) {
            if (!runtime.currentById.has(id)) runtime.pendingSettledIds.add(id)
          }
          // Every change RE-arms the timer, so the event fires settleMs
          // after the LAST change — quiet-period semantics, detected at
          // the source instead of guessed by a poller.
          armSettle(consumer, runtime)
        } else if (runtime.fingerprint === null) {
          runtime.lastEmittedById = new Map(runtime.currentById)
        }
        runtime.fingerprint = fingerprint
      } while (runtime.recheck)
    } finally {
      runtime.computing = false
    }
  }

  const requestCompute = (db: PowerSyncDb, consumer: string, runtime: WatcherRuntime) => {
    if (runtime.disposed) return
    runtime.dirty = true
    const entry = entries.get(consumer)
    // Only the runtime's OWN entry may vouch for its freshness — after a
    // replace-registration, `entries` holds the successor's entry.
    if (!entry || !entry.runtimes.includes(runtime)) return
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
      db,
      runtimes: watchers.map(watcherRuntimeFor),
    }
    entries.set(consumer, entry)

    try {
      // Baseline before subscribing: the current result set must never
      // fire (mirrors the daemon's own first-tick baseline).
      await Promise.all(entry.runtimes.map(runtime => computeLoop(db, consumer, runtime)))
    } catch (error) {
      disposeEntry(consumer, entry)
      throw error
    }

    // Commands run concurrently in the tab: a second registration for
    // this consumer may have replaced ours while we baselined. The
    // successor owns the consumer — subscribing our runtimes anyway
    // would leave live watchers no dispose path can ever reach.
    if (entries.get(consumer) !== entry) {
      disposeEntry(consumer, entry)
      return {consumer, registered: [], unchanged: false}
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

  /** Blur / explicit-signal path: the user is DONE with `blockId`, so
   *  don't wait out the settle window for changes it caused. Recompute
   *  now, flush any pending settle that involves this block, and look
   *  once more shortly after — the editor's debounced content commit
   *  usually lands just AFTER the blur signal. */
  const recheckTimers = new Set<ReturnType<typeof setTimeout>>()

  const notifyBlockSettled = (blockId: string) => {
    // The blur signal fires on EVERY block-editor unmount (any block-to-
    // block navigation) and the bridge wires it whenever it runs — with
    // no registrations there is nothing to flush, and recording blurs
    // would only grow state.
    if (entries.size === 0) return

    // Opportunistic prune keeps the map proportional to blurs inside the
    // exempt window instead of growing per block ever visited.
    for (const [id, until] of blurredUntil) {
      if (now() > until) blurredUntil.delete(id)
    }
    blurredUntil.set(blockId, now() + BLUR_EXEMPT_MS)

    const flushPass = async () => {
      for (const [consumer, entry] of [...entries]) {
        if (now() - entry.lastRefreshedMs > entry.ttlMs) {
          disposeConsumer(consumer)
          continue
        }
        for (const runtime of entry.runtimes) {
          // Re-run the query only when a change signal arrived that no
          // compute consumed yet — an edit-free navigation must not turn
          // into a per-watcher query storm.
          if (!runtime.computing && runtime.dirty) {
            await computeLoop(entry.db, consumer, runtime).catch(error => {
              console.warn(`watch-events: ${consumer}/${runtime.name} query failed`, error)
            })
          }
          if (runtime.settleTimer !== null && runtime.pendingSettledIds.has(blockId)) {
            clearTimeout(runtime.settleTimer)
            runtime.settleTimer = null
            emitSettled(consumer, runtime, false)
            // Ids that were NOT blur-confirmed (e.g. a concurrent sync
            // edit) keep their normal settle window.
            if (runtime.pendingSettledIds.size > 0) armSettle(consumer, runtime)
          }
        }
      }
    }

    void flushPass()
    const timer = setTimeout(() => {
      recheckTimers.delete(timer)
      void flushPass()
    }, BLUR_RECHECK_MS)
    recheckTimers.add(timer)
  }

  const disposeAll = () => {
    for (const consumer of [...entries.keys()]) disposeConsumer(consumer)
    for (const timer of recheckTimers) clearTimeout(timer)
    recheckTimers.clear()
    blurredUntil.clear()
  }

  return {register, setTransport, notifyBlockSettled, disposeAll}
}

export type WatchEventsRegistry = ReturnType<typeof createWatchEventsRegistry>

/** The app-wide instance: commands.ts registers into it, bridge.ts owns
 *  its transport lifecycle. */
export const watchEventsRegistry = createWatchEventsRegistry()
