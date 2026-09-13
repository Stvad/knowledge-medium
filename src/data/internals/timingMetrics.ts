/*
 * Timing-based metrics: bounded reservoir + DB / query wrappers.
 *
 * Counterpart to the simple-counter metrics on HandleStore / BlockCache.
 * Where those answer "how often", these answer "how long".
 *
 * Approximate percentiles via a fixed-capacity ring buffer — accurate
 * enough for "is this 10 ms or 100 ms?"; for higher-precision
 * distributions use the bench harness instead.
 */

/** Approximate-percentile ring buffer. Records the last `capacity`
 *  samples; `snapshot()` sorts a copy on demand. `calls` is the total
 *  observed across the lifetime of the reservoir (not bounded by
 *  capacity), so consumers can still read "how many samples have we
 *  seen?" even after the buffer wrapped. */
export class TimingReservoir {
  private readonly capacity: number
  private readonly samples: number[]
  private writeIdx = 0
  private filled = false
  private callsTotal = 0
  private sumMs = 0

  constructor(capacity = 256) {
    if (capacity <= 0) throw new Error(`TimingReservoir capacity must be positive, got ${capacity}`)
    this.capacity = capacity
    this.samples = []
  }

  record(ms: number): void {
    this.callsTotal++
    this.sumMs += ms
    if (!this.filled && this.samples.length < this.capacity) {
      this.samples.push(ms)
      if (this.samples.length === this.capacity) this.filled = true
      return
    }
    this.samples[this.writeIdx] = ms
    this.writeIdx = (this.writeIdx + 1) % this.capacity
  }

  reset(): void {
    this.samples.length = 0
    this.writeIdx = 0
    this.filled = false
    this.callsTotal = 0
    this.sumMs = 0
  }

  /** Frozen plain-object summary. Percentile values are 0 when
   *  `sampleCount === 0` (no samples yet); consumers should branch
   *  on that field rather than treating 0 as a real measurement. */
  snapshot(): TimingSnapshot {
    const n = this.samples.length
    if (n === 0) {
      return Object.freeze({
        calls: this.callsTotal,
        sampleCount: 0,
        meanMs: 0,
        p50Ms: 0,
        p95Ms: 0,
        p99Ms: 0,
        minMs: 0,
        maxMs: 0,
        totalMs: this.sumMs,
      })
    }
    // Sort a copy — the live buffer is rotated, not order-preserved.
    const sorted = this.samples.slice().sort((a, b) => a - b)
    const at = (q: number) => sorted[Math.min(n - 1, Math.floor(n * q))]
    let windowSum = 0
    for (const s of sorted) windowSum += s
    return Object.freeze({
      calls: this.callsTotal,
      sampleCount: n,
      meanMs: windowSum / n,
      p50Ms: at(0.5),
      p95Ms: at(0.95),
      p99Ms: at(0.99),
      minMs: sorted[0],
      maxMs: sorted[n - 1],
      totalMs: this.sumMs,
    })
  }
}

/** Frozen summary returned by `TimingReservoir.snapshot()`. */
export interface TimingSnapshot {
  /** Total samples observed since last reset (NOT bounded by buffer
   *  capacity). */
  readonly calls: number
  /** Samples actually retained in the ring buffer (capped at
   *  `capacity`). p50/p95/p99 are computed over these. */
  readonly sampleCount: number
  /** Mean of the samples in the window (not the lifetime sum / calls
   *  — that pairs poorly with windowed percentiles when the buffer
   *  has wrapped). */
  readonly meanMs: number
  readonly p50Ms: number
  readonly p95Ms: number
  readonly p99Ms: number
  readonly minMs: number
  readonly maxMs: number
  /** Sum of every observed call's duration, across the full lifetime
   *  of the reservoir (not bounded by capacity). Useful for "this
   *  query has spent X ms total since the page opened." */
  readonly totalMs: number
}

// ──── connection contention ────

/** A db call's life in the connection pool, from issue to completion. */
export interface ContentionTicket {
  readonly issuedAt: number
  readonly mark: ContentionMark
}

/** The counters a window is judged against: taken when it opens, compared when
 *  it closes. A window is clean only if none of them moved.
 *
 *  `generation` is what makes the comparison an IDENTITY rather than an
 *  arithmetic coincidence. `resetMetrics()` zeroes the counters while windows
 *  are open, after which they climb again and can pass back through the value a
 *  live mark holds — a contended window reading as clean. A window that spans a
 *  reset is not judgeable, and this is how it says so. */
export interface ContentionMark {
  readonly generation: number
  readonly depth: number
  readonly concurrentIssues: number
  readonly sharedWork: number
}

/** An open query-resolve window. Distinct from a `ContentionTicket`: a ticket
 *  OCCUPIES the pool, a window merely OBSERVES it, and the count of open
 *  windows is what decides whether coalesced work was actually shared. */
export interface ContentionWindow {
  readonly mark: ContentionMark
}

/** Frozen summary returned by `DbContention.snapshot()`. */
export interface ContentionSnapshot {
  /** Top-level db calls that took a connection since the last reset. */
  readonly calls: number
  /** Of those, ones issued while the pool was already occupied. */
  readonly concurrentIssues: number
  /** Deepest simultaneous occupancy seen, our calls and observed sync work
   *  together. `1` means nothing ever overlapped. */
  readonly maxDepth: number
  /** Union of the intervals during which the pool was occupied — NOT the sum
   *  of call durations, which double-counts overlap. Against a window's elapsed
   *  time, how much of it the database was idle for. */
  readonly busyMs: number
  /** Coalescer flushes that answered more than one open observer. */
  readonly sharedWork: number
  /** Calls that ran with the pool to themselves. */
  readonly uncontendedCalls: number
  /** Read timings over the uncontended calls ONLY — the data layer's own
   *  speed, with every queued sample left out rather than modelled away. */
  readonly uncontendedRead: TimingSnapshot
  /** Intervals of database work by the sync engine, which this cannot time but
   *  can bracket. Zero on a local-only session; zero ALSO when the status
   *  channel is unavailable, which is why `syncObserved` exists beside it. */
  readonly foreignIntervals: number
  /** Whether sync activity is being observed at all. False means the samples
   *  above cannot account for it — a caveat on every figure here, not a claim
   *  that the pool was quiet. */
  readonly syncObserved: boolean
}

/**
 * Occupancy bookkeeping for the database connection pool, and the one question
 * it exists to answer: DID THIS WINDOW HAVE THE POOL TO ITSELF?
 *
 * A caller's wall-clock is request→resolution, so on a pool with fewer
 * connections than callers it is dominated by the queue ahead of it rather than
 * by the work. A figure like that moves when render order changes, and so does
 * every verdict built on it.
 *
 * The answer is SELECTION, not correction: rather than subtract an estimated
 * queue wait, record which observations had no queue and report those
 * separately. `uncontendedRead` and `QueryMetrics`' per-name uncontended
 * reservoir are concurrency-independent because of what they EXCLUDE, so they
 * survive a change in fan-out that moves every other timing in this file.
 *
 * DECLINED: decomposing each call into service and queue time. It needs a
 * serial FIFO connection, and `repoProvider` opens two on OPFSWriteAheadVFS and
 * one elsewhere — so the split would be wrong, silently, on some devices.
 *
 * Three kinds of occupancy, because a claim about "the pool" has to cover
 * everything on it:
 *   - our own calls, timed (`begin`/`end`);
 *   - the sync engine's, which connects to the raw database before `Repo` wraps
 *     it and so is invisible here — bracketed by status (`beginForeign`);
 *   - work one read does on several observers' behalf (`noteSharedWork`).
 *
 * The classification is CONSERVATIVE in one direction on purpose: a call that
 * overlapped another harmlessly (two reads, two free connections) is excluded
 * anyway. Excluding a clean sample costs a little statistical power; admitting
 * a queued one costs the metric its meaning.
 */
export class DbContention {
  private inFlight = 0
  private busySince: number | null = null
  private busyAccruedMs = 0
  private callsTotal = 0
  private concurrentIssuesTotal = 0
  private maxDepthSeen = 0
  private sharedWorkTotal = 0
  private uncontendedTotal = 0
  private foreignTotal = 0
  private openWindows = 0
  /** Bumped by `reset()`. Marks from an earlier span are not comparable to the
   *  current counters, whatever they now read. */
  private generation = 0
  private syncWatched = false
  /** Uncontended read timings. Writes are excluded — they serialise on the
   *  writer connection whatever else is happening, so "had the pool to itself"
   *  does not mean for them what it means for a read. */
  readonly uncontendedRead = new TimingReservoir()

  /** `now` is injectable so tests can drive overlap deterministically; every
   *  production caller takes the default. */
  constructor(private readonly now: () => number = () => performance.now()) {}

  private currentMark(): ContentionMark {
    return {
      generation: this.generation,
      depth: this.inFlight,
      concurrentIssues: this.concurrentIssuesTotal,
      sharedWork: this.sharedWorkTotal,
    }
  }

  /** Was the window opened at `mark` free of competition? Same counter span,
   *  nothing occupying the pool when it opened, nothing arriving while it was
   *  open, and no coalesced read answering it alongside another observer. */
  private isClean(mark: ContentionMark): boolean {
    return this.generation === mark.generation &&
      mark.depth === 0 &&
      this.concurrentIssuesTotal === mark.concurrentIssues &&
      this.sharedWorkTotal === mark.sharedWork
  }

  /** Open an observation window for one query resolve. Pair with
   *  `closeWindow` in a `finally`. */
  openWindow(): ContentionWindow {
    this.openWindows++
    return {mark: this.currentMark()}
  }

  /** Close it, and say whether it ran unopposed. */
  closeWindow(window: ContentionWindow): boolean {
    this.openWindows--
    return this.isClean(window.mark)
  }

  /** One read answered several callers at once. Called by request coalescers
   *  (`ancestorBatch`), the only place that fact is known.
   *
   *  Recorded ONLY while more than one observation window is open, and that
   *  condition is the whole point. A resolver that deliberately asks for many
   *  ids in one go (`core.manyAncestors`, `core.recentActivity`) is a single
   *  observation whose batch is its own work; billing it as shared would bar it
   *  from ever being measured cleanly. What has to be caught is the other
   *  shape: N separate resolves awaiting one statement, each recording its full
   *  wall-clock, which is one observation reported N times. */
  noteSharedWork(): void {
    if (this.openWindows > 1) this.sharedWorkTotal++
  }

  private enter(at: number): ContentionMark {
    const mark = this.currentMark()
    if (this.inFlight === 0) this.busySince = at
    else this.concurrentIssuesTotal++
    this.inFlight++
    if (this.inFlight > this.maxDepthSeen) this.maxDepthSeen = this.inFlight
    return mark
  }

  private leave(at: number): void {
    this.inFlight--
    if (this.inFlight === 0 && this.busySince !== null) {
      this.busyAccruedMs += at - this.busySince
      this.busySince = null
    }
  }

  /** Take a connection. Pair with `end` in a `finally`. */
  begin(): ContentionTicket {
    const issuedAt = this.now()
    const mark = this.enter(issuedAt)
    this.callsTotal++
    return {issuedAt, mark}
  }

  /** Release the connection and return the call's wall-clock, so the caller
   *  records one duration from one pair of clock reads. */
  end(ticket: ContentionTicket, kind: 'read' | 'write'): number {
    const completedAt = this.now()
    this.leave(completedAt)
    const durationMs = completedAt - ticket.issuedAt
    if (this.isClean(ticket.mark)) {
      this.uncontendedTotal++
      if (kind === 'read') this.uncontendedRead.record(durationMs)
    }
    return durationMs
  }

  /** The sync engine is working on the same connections. Occupancy only: it is
   *  bracketed from status transitions, not timed, and it bumps no call count —
   *  it is not ours to report as a db call, only to refuse to ignore. */
  beginForeign(): void {
    this.enter(this.now())
    this.foreignTotal++
  }

  endForeign(): void {
    this.leave(this.now())
  }

  /** Whether sync activity reaches this tracker at all. */
  observingSync(): boolean {
    return this.syncWatched
  }

  markSyncObserved(): void {
    this.syncWatched = true
  }

  /** Zero the counters and start a new span. IN-FLIGHT STATE IS KEPT:
   *  `inFlight` and `openWindows` track work that will still call back, and
   *  zeroing them would drive the counts negative and mis-classify everything
   *  after. Work already open settles into the new span, matching
   *  `resetMetrics`' documented behaviour for the reservoirs — but it is not
   *  JUDGED in it, which is what `generation` above enforces. */
  reset(): void {
    this.generation++
    this.busyAccruedMs = 0
    this.busySince = this.inFlight > 0 ? this.now() : null
    this.callsTotal = 0
    this.concurrentIssuesTotal = 0
    this.maxDepthSeen = this.inFlight
    this.sharedWorkTotal = 0
    this.uncontendedTotal = 0
    this.foreignTotal = 0
    this.uncontendedRead.reset()
  }

  snapshot(): ContentionSnapshot {
    return Object.freeze({
      calls: this.callsTotal,
      concurrentIssues: this.concurrentIssuesTotal,
      maxDepth: this.maxDepthSeen,
      // Includes the open interval, so a snapshot taken mid-flight doesn't
      // report the database idle while it is working.
      busyMs: this.busyAccruedMs + (this.busySince === null ? 0 : this.now() - this.busySince),
      sharedWork: this.sharedWorkTotal,
      uncontendedCalls: this.uncontendedTotal,
      uncontendedRead: this.uncontendedRead.snapshot(),
      foreignIntervals: this.foreignTotal,
      syncObserved: this.syncWatched,
    })
  }
}

/** The contention tracker for a metrics-wrapped db, reachable from the db
 *  alone. `WeakMap` for the same reason `ancestorBatch` keys its batchers that
 *  way: a coalescer holding only `ctx.db` has to be able to report shared work
 *  without the Repo threading a sink through every query signature. */
const contentionByDb = new WeakMap<object, DbContention>()

/** The tracker for `db`, or undefined if it was never wrapped (tests and
 *  fixtures pass raw databases). */
export const contentionFor = (db: unknown): DbContention | undefined =>
  typeof db === 'object' && db !== null ? contentionByDb.get(db) : undefined

/** The PowerSync status surface, structurally — same defensive shape as
 *  `firstSync.ts`, so this module still pulls no PowerSync types. */
interface SyncStatusDb {
  currentStatus?: SyncStatus
  registerListener?: (l: {statusChanged?: (s: SyncStatus) => void}) => () => void
}
interface SyncStatus {
  dataFlowStatus?: {downloading?: boolean; uploading?: boolean}
}

const syncBusy = (s: SyncStatus | undefined): boolean =>
  s?.dataFlowStatus?.downloading === true || s?.dataFlowStatus?.uploading === true

/**
 * Bracket the sync engine's database work as pool occupancy.
 *
 * Without this the tracker sees only calls made through the Repo's proxy, and
 * the sync engine is not one of them: `repoProvider` connects it to the RAW
 * database before `Repo` ever wraps it. Its downloads and uploads run on the
 * same connections, so a read queued behind them would be recorded as having
 * had the pool to itself — the same queue-as-latency defect this whole file
 * exists to end, re-entering through the one door the proxy does not cover.
 *
 * Transitions, not polling: a burst that begins and ends inside one resolve is
 * invisible to a status read taken at each end of it.
 *
 * The listener's lifetime is the database's. Nothing detaches it, because the
 * tracker it feeds lives exactly as long — both are created here, once, per
 * wrapped db.
 */
const watchSyncOccupancy = (db: unknown, pool: DbContention): void => {
  const statusDb = db as SyncStatusDb
  if (typeof statusDb.registerListener !== 'function') return
  let open = false
  const apply = (status: SyncStatus | undefined): void => {
    const busy = syncBusy(status)
    if (busy === open) return
    open = busy
    if (busy) pool.beginForeign()
    else pool.endForeign()
  }
  pool.markSyncObserved()
  statusDb.registerListener({statusChanged: apply})
  // Sync may already be running when the Repo is built.
  apply(statusDb.currentStatus)
}

/** Aggregate timings for every PowerSyncDb call that flows through the
 *  Repo (`getAll`, `getOptional`, `get`, `execute`, `writeTransaction`).
 *  Use to tell whether a slow cold-start lives in raw SQL roundtrip cost
 *  or above it. One instance per Repo. */
export class DbMetrics {
  readonly getAll = new TimingReservoir()
  readonly getOptional = new TimingReservoir()
  readonly get = new TimingReservoir()
  readonly execute = new TimingReservoir()
  /** Total `db.writeTransaction(...)` wall time, including commit
   *  overhead. Tx-internal SQL calls (via the LockContext) are timed
   *  separately under their respective fields above — so a single
   *  `mutate.setContent` typically registers 1 writeTransaction sample
   *  AND a handful of `getAll`/`execute` samples for the inner work. */
  readonly writeTransaction = new TimingReservoir()
  /** Which of the timings above were taken with the pool to themselves, and
   *  how busy the pool was. Surfaced separately from `snapshot()` — the
   *  per-method record is a uniform map of `TimingSnapshot`, and its consumers
   *  iterate it. */
  readonly contention = new DbContention()

  reset(): void {
    this.getAll.reset()
    this.getOptional.reset()
    this.get.reset()
    this.execute.reset()
    this.writeTransaction.reset()
    this.contention.reset()
  }

  snapshot(): Readonly<Record<string, TimingSnapshot>> {
    return Object.freeze({
      getAll: this.getAll.snapshot(),
      getOptional: this.getOptional.snapshot(),
      get: this.get.snapshot(),
      execute: this.execute.snapshot(),
      writeTransaction: this.writeTransaction.snapshot(),
    })
  }
}

/** Per-query-name resolve timings. Keys are full query names
 *  (`core.subtree`, `plugin:foo/bar`, …); empty entries don't appear in
 *  the snapshot — only queries that actually ran are surfaced.
 *  Re-resolves (LoaderHandle.invalidate) count as separate samples — the
 *  dispatcher path runs the loader fresh each time, and that's the unit
 *  you care about for "open page → ms to settle". */
export class QueryMetrics {
  private readonly perName = new Map<string, {all: TimingReservoir; uncontended: TimingReservoir}>()

  /** Record one `loader(ctx)` invocation for `queryName`. Lazily
   *  creates a reservoir on first call so unused queries cost nothing.
   *  Capacity defaults to 256 — same as the DbMetrics reservoirs.
   *
   *  `uncontended` (from `DbContention.wasUncontended`) says the resolve had
   *  the connection pool to itself for its whole life. Those samples go to a
   *  SECOND reservoir as well as the first, and that one is the only per-query
   *  timing here a reader can compare across sessions: the rest move with how
   *  many other queries a surface happened to fan out alongside this one. */
  record(queryName: string, ms: number, uncontended: boolean): void {
    let r = this.perName.get(queryName)
    if (!r) {
      r = {all: new TimingReservoir(), uncontended: new TimingReservoir()}
      this.perName.set(queryName, r)
    }
    r.all.record(ms)
    if (uncontended) r.uncontended.record(ms)
  }

  reset(): void {
    for (const r of this.perName.values()) { r.all.reset(); r.uncontended.reset() }
    // Drop empty entries entirely so a long-running session that
    // touched a query once doesn't keep paying for its bookkeeping.
    this.perName.clear()
  }

  snapshot(): Readonly<Record<string, QueryTimingSnapshot>> {
    const out: Record<string, QueryTimingSnapshot> = {}
    for (const [name, r] of this.perName) {
      out[name] = Object.freeze({...r.all.snapshot(), uncontended: r.uncontended.snapshot()})
    }
    return Object.freeze(out)
  }
}

/** One query's timings: every resolve, plus the subset that ran unopposed.
 *  `uncontended.calls` is also the honest answer to "how many independent
 *  measurements back this?" — coalesced callers never reach it. */
export interface QueryTimingSnapshot extends TimingSnapshot {
  readonly uncontended: TimingSnapshot
}

// ──── DB wrapper ────

/** Thin shape we actually wrap. Mirrors the `PowerSyncDb` interface
 *  in `commitPipeline.ts` but kept loose here so this module doesn't
 *  pull the full type — `wrapDbWithMetrics` returns whatever it was
 *  given, with timing-instrumented call sites. */
interface TimedDb {
  writeTransaction<R>(fn: (tx: TimedTxDb) => Promise<R>): Promise<R>
  getAll<T>(sql: string, params?: unknown[]): Promise<T[]>
  getOptional<T>(sql: string, params?: unknown[]): Promise<T | null>
  get<T>(sql: string, params?: unknown[]): Promise<T>
  execute(sql: string, params?: unknown[]): Promise<unknown>
  onChange?: (...args: unknown[]) => unknown
}

interface TimedTxDb {
  execute(sql: string, params?: unknown[]): Promise<unknown>
  getAll<T>(sql: string, params?: unknown[]): Promise<T[]>
  getOptional<T>(sql: string, params?: unknown[]): Promise<T | null>
  get<T>(sql: string, params?: unknown[]): Promise<T>
}

/** Wrap a `PowerSyncDb` with timing instrumentation. Returns a Proxy
 *  over the input — five methods (`getAll`, `getOptional`, `get`,
 *  `execute`, `writeTransaction`) are intercepted and timed; everything
 *  else (`onChange`, `close`, …) passes through to the original db.
 *  This means consumers like `exportSqliteDb` that need
 *  PowerSyncDatabase-only methods continue to work without us
 *  re-declaring them.
 *
 *  `writeTransaction` also wraps the LockContext passed to the callback
 *  so tx-internal SQL is timed under the same metrics buckets.
 *
 *  Type-erased to `unknown` here so the module doesn't import
 *  `PowerSyncDb`; `Repo` casts at the call site (it owns the
 *  `PowerSyncDb` type contract). */
export const wrapDbWithMetrics = (rawDb: unknown, metrics: DbMetrics): unknown => {
  const db = rawDb as TimedDb
  const wrappedTx = wrapTxDb.bind(null, metrics)
  const pool = metrics.contention

  /** Every top-level call holds a connection for its whole life, so each one
   *  is timed through the pool: one ticket, one duration, one classification.
   *  Calls made through the LockContext INSIDE a writeTransaction are not —
   *  they run within the transaction's own ticket, and counting them again
   *  would report a connection competing with itself. */
  const timed = async <R>(
    kind: 'read' | 'write',
    reservoir: TimingReservoir,
    run: () => Promise<R>,
  ): Promise<R> => {
    const ticket = pool.begin()
    try {
      return await run()
    } finally {
      reservoir.record(pool.end(ticket, kind))
    }
  }

  const timedWriteTransaction = <R>(fn: (tx: TimedTxDb) => Promise<R>): Promise<R> =>
    timed('write', metrics.writeTransaction, () =>
      db.writeTransaction(async (tx: TimedTxDb): Promise<R> => fn(wrappedTx(tx))))

  const timedGetAll = <T>(sql: string, params?: unknown[]): Promise<T[]> =>
    timed('read', metrics.getAll, () => db.getAll<T>(sql, params))

  const timedGetOptional = <T>(sql: string, params?: unknown[]): Promise<T | null> =>
    timed('read', metrics.getOptional, () => db.getOptional<T>(sql, params))

  const timedGet = <T>(sql: string, params?: unknown[]): Promise<T> =>
    timed('read', metrics.get, () => db.get<T>(sql, params))

  const timedExecute = (sql: string, params?: unknown[]): Promise<unknown> =>
    timed('write', metrics.execute, () => db.execute(sql, params))

  const overrides: Record<string, unknown> = {
    writeTransaction: timedWriteTransaction,
    getAll: timedGetAll,
    getOptional: timedGetOptional,
    get: timedGet,
    execute: timedExecute,
  }

  // Proxy delegates everything else to the underlying db. Bind any
  // function-typed pass-through (e.g. onChange) to the original
  // receiver so they don't lose `this`. Properties that aren't
  // functions return as-is.
  const proxy = new Proxy(db as object, {
    get(target, prop, receiver) {
      if (typeof prop === 'string' && prop in overrides) {
        return overrides[prop]
      }
      const value = Reflect.get(target, prop, receiver)
      if (typeof value === 'function') return value.bind(target)
      return value
    },
  })
  // Keyed by the PROXY, not the raw db: `contentionFor` is looked up from the
  // same object a resolver holds as `ctx.db`.
  contentionByDb.set(proxy, pool)
  // Watched on the RAW db: the sync engine was connected to it before this
  // wrapper existed, and the status channel lives there.
  watchSyncOccupancy(db, pool)
  return proxy
}

/** LockContext-shape wrapper used inside writeTransaction. Same idea
 *  as wrapDbWithMetrics: time every read/exec call going through the
 *  tx so `mutate.X` shows up under both `writeTransaction` (wall) and
 *  the per-call buckets (its inner SQL). */
const wrapTxDb = (metrics: DbMetrics, tx: TimedTxDb): TimedTxDb => ({
  execute: async (sql: string, params?: unknown[]): Promise<unknown> => {
    const t0 = performance.now()
    try {
      return await tx.execute(sql, params)
    } finally {
      metrics.execute.record(performance.now() - t0)
    }
  },
  getAll: async <T>(sql: string, params?: unknown[]): Promise<T[]> => {
    const t0 = performance.now()
    try {
      return await tx.getAll<T>(sql, params)
    } finally {
      metrics.getAll.record(performance.now() - t0)
    }
  },
  getOptional: async <T>(sql: string, params?: unknown[]): Promise<T | null> => {
    const t0 = performance.now()
    try {
      return await tx.getOptional<T>(sql, params)
    } finally {
      metrics.getOptional.record(performance.now() - t0)
    }
  },
  get: async <T>(sql: string, params?: unknown[]): Promise<T> => {
    const t0 = performance.now()
    try {
      return await tx.get<T>(sql, params)
    } finally {
      metrics.get.record(performance.now() - t0)
    }
  },
})
