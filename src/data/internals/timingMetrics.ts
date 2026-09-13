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

/** The counters a window is judged against. Taken before the window opens and
 *  handed back to `wasUncontended` after it closes — a window is clean only if
 *  none of these moved while it was open. */
export interface ContentionMark {
  /** Calls in flight when the window opened. */
  readonly depth: number
  readonly concurrentIssues: number
  readonly sharedWork: number
}

/** Frozen summary returned by `DbContention.snapshot()`. Every field is an
 *  OBSERVATION of the pool, not a model of it — see the class comment for why
 *  that distinction is the whole point. */
export interface ContentionSnapshot {
  /** Top-level db calls that took a connection since the last reset. */
  readonly calls: number
  /** Of those, ones issued while another was already in flight. */
  readonly concurrentIssues: number
  /** Deepest simultaneous in-flight count seen. `1` means nothing ever
   *  overlapped; higher means callers were competing for connections. */
  readonly maxDepth: number
  /** Union of the intervals during which at least one call was in flight —
   *  NOT the sum of call durations, which double-counts overlap. Pair with a
   *  window's elapsed time to see how much of it the database was idle for. */
  readonly busyMs: number
  /** Flushes by a request coalescer that served more than one caller (see
   *  `noteSharedWork`). Each one is work whose cost N callers all record. */
  readonly sharedWork: number
  /** Calls that ran with the pool to themselves. */
  readonly uncontendedCalls: number
  /** Read timings over the uncontended calls ONLY — the data layer's own
   *  speed, with every queued sample left out rather than modelled away. */
  readonly uncontendedRead: TimingSnapshot
}

/**
 * In-flight bookkeeping for the database connection pool, and the one question
 * it exists to answer: DID THIS WINDOW HAVE THE POOL TO ITSELF?
 *
 * A caller's wall-clock is request→resolution, so on a pool with fewer
 * connections than callers it is dominated by the queue ahead of it. Measured
 * 2026-09-13 on a live client: 268 reads recorded 23,116ms inside a 6,005ms
 * window — 3.85x the elapsed time, which only overlapping waits can produce.
 * A figure like that moves when render order changes, so every verdict built on
 * it does too.
 *
 * The fix here is SELECTION, not correction: rather than subtract an estimated
 * queue wait, record which observations had no queue and report those
 * separately. `uncontendedRead` and `QueryMetrics`' per-name uncontended
 * reservoir are concurrency-independent because of what they exclude, so they
 * survive a change in fan-out that moves every other timing in this file.
 *
 * DELIBERATELY NO MODEL OF THE POOL. An earlier draft decomposed each call into
 * service and queue time by assuming one serial FIFO connection. That premise
 * is false: `repoProvider` opens `1 + ADDITIONAL_READERS` connections on
 * OPFSWriteAheadVFS and one on the others, and measurement on a two-connection
 * client showed reads running 2-way parallel while writes serialised on the
 * writer — so the decomposition would have been silently wrong on the devices
 * it was written for. Every field above holds whatever the pool's shape is.
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
  /** Uncontended read timings. Writes are excluded — they serialise on the
   *  writer connection whatever else is happening, so "had the pool to itself"
   *  does not mean for them what it means for a read. */
  readonly uncontendedRead = new TimingReservoir()

  /** `now` is injectable so tests can drive overlap deterministically; every
   *  production caller takes the default. */
  constructor(private readonly now: () => number = () => performance.now()) {}

  /** Counters as they stand. Hand the result to `wasUncontended` once the
   *  window you are judging has closed. */
  mark(): ContentionMark {
    return {
      depth: this.inFlight,
      concurrentIssues: this.concurrentIssuesTotal,
      sharedWork: this.sharedWorkTotal,
    }
  }

  /** Did the window opened at `mark` run without competition? Nothing was in
   *  flight when it opened, nothing arrived while it was open, and no coalesced
   *  flush served a second caller during it. */
  wasUncontended(mark: ContentionMark): boolean {
    return mark.depth === 0 &&
      this.concurrentIssuesTotal === mark.concurrentIssues &&
      this.sharedWorkTotal === mark.sharedWork
  }

  /** One caller's cost was paid by work done for several. Called by request
   *  coalescers (`ancestorBatch`) when a flush serves more than one caller —
   *  the ONE place that fact is known. Without it N callers awaiting a single
   *  statement each look like an independent, uncontended measurement of it:
   *  the pool really was idle for each of them, and the figure they all record
   *  is still one observation, not N. */
  noteSharedWork(): void {
    this.sharedWorkTotal++
  }

  /** Take a connection. Pair with `end` in a `finally`. */
  begin(): ContentionTicket {
    const issuedAt = this.now()
    const mark = this.mark()
    if (this.inFlight === 0) this.busySince = issuedAt
    else this.concurrentIssuesTotal++
    this.inFlight++
    if (this.inFlight > this.maxDepthSeen) this.maxDepthSeen = this.inFlight
    this.callsTotal++
    return {issuedAt, mark}
  }

  /** Release the connection and return the call's wall-clock, so the caller
   *  records one duration from one pair of clock reads. */
  end(ticket: ContentionTicket, kind: 'read' | 'write'): number {
    const completedAt = this.now()
    this.inFlight--
    if (this.inFlight === 0 && this.busySince !== null) {
      this.busyAccruedMs += completedAt - this.busySince
      this.busySince = null
    }
    const durationMs = completedAt - ticket.issuedAt
    if (this.wasUncontended(ticket.mark)) {
      this.uncontendedTotal++
      if (kind === 'read') this.uncontendedRead.record(durationMs)
    }
    return durationMs
  }

  /** Zero the counters. IN-FLIGHT STATE IS KEPT: `inFlight` tracks calls that
   *  will still call `end`, and zeroing it would drive the count negative and
   *  mis-classify everything after. Calls already open settle into the new
   *  span, matching `resetMetrics`' documented behaviour for the reservoirs. */
  reset(): void {
    this.busyAccruedMs = 0
    this.busySince = this.inFlight > 0 ? this.now() : null
    this.callsTotal = 0
    this.concurrentIssuesTotal = 0
    this.maxDepthSeen = this.inFlight
    this.sharedWorkTotal = 0
    this.uncontendedTotal = 0
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
