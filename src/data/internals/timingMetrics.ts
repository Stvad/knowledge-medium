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
  /** Arrivals into an already-occupied pool, DATABASE CALLS AND BRACKETED SYNC
   *  INTERVALS alike. The question a window asks is whether anything joined
   *  while it was open, and for that the two are the same event. Distinct from
   *  the reported `concurrentIssues`, which counts only real calls, so that it
   *  cannot exceed `calls`. */
  readonly disturbances: number
  readonly sharedWork: number
}

/** An open query-resolve window. Distinct from a `ContentionTicket`: a ticket
 *  OCCUPIES the pool, a window merely OBSERVES it. */
export interface ContentionWindow {
  readonly mark: ContentionMark
}

/** Frozen summary returned by `DbContention.snapshot()`. */
export interface ContentionSnapshot {
  /** Top-level db calls that took a connection since the last reset. */
  readonly calls: number
  /** Of those, the ones issued while the pool was already occupied. Counts
   *  DATABASE CALLS only, so it stays a subset of `calls` — bracketed sync
   *  intervals disturb a window just as much, but folding them in here would
   *  let this field exceed `calls` and stop meaning what it says. `calls` minus
   *  this is `uncontendedCalls`: every call is one or the other. */
  readonly concurrentIssues: number
  /** Deepest simultaneous occupancy seen, our calls and observed sync work
   *  together. `1` means nothing ever overlapped. */
  readonly maxDepth: number
  /** Union of the intervals during which the pool was occupied by anything this
   *  tracker saw — our calls AND bracketed sync work, which starts an interval
   *  of its own. NOT the sum of call durations, which double-counts overlap.
   *  Against elapsed time it bounds how much of a window the database was idle
   *  for, from below: unobserved work looks like idleness here too. */
  readonly busyMs: number
  /** Coalescer flushes that answered more than one caller. */
  readonly sharedWork: number
  /** Calls, reads and writes together, issued into an OBSERVABLY empty pool.
   *  Not a guarantee they did not wait: what this cannot see it cannot count,
   *  and the sync engine's work outside its status intervals is exactly that. */
  readonly uncontendedCalls: number
  /** Read timings over those READS only — a strict subset of
   *  `uncontendedCalls`, so read its own `calls` rather than that number: a
   *  session with unqueued writes and no unqueued reads would otherwise look
   *  like a real distribution of zero-millisecond reads. */
  readonly uncontendedRead: TimingSnapshot
  /** Intervals during which the sync engine reported itself active. NOT a
   *  measure of its database work — it reports network time too, and touches
   *  the database outside what it reports (see `watchSyncOccupancy`). Zero on a
   *  local-only session; zero ALSO when the status channel is unavailable,
   *  which is why `syncObserved` exists beside it. */
  readonly foreignIntervals: number
  /** Whether sync activity is being observed at all. False means the samples
   *  above cannot account for it — a caveat on every figure here, not a claim
   *  that the pool was quiet. True means PARTIALLY accounted for, on the terms
   *  above. */
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
 * reservoir are filtered by OBSERVABLE occupancy, which is what lets them
 * survive a change in fan-out that moves every other timing in this file.
 * Filtered, not independent: what the filter cannot see it cannot exclude, and
 * the second qualification below is exactly that case.
 *
 * DECLINED: decomposing each call into service and queue time. It needs a
 * serial FIFO connection, and `repoProvider` opens two on OPFSWriteAheadVFS and
 * one elsewhere — so the split would be wrong, silently, on some devices.
 *
 * Three kinds of occupancy, because a claim about "the pool" has to cover
 * everything on it:
 *   - every call that crosses the database adapter (`begin`/`end`, fed by
 *     `instrumentAdapter`) — complete for this tab, whoever made it: the Repo,
 *     PowerSync's own helpers, a caller holding the raw handle;
 *   - the sync engine's, bracketed from its status channel (`beginForeign`) —
 *     wrong in both directions, deliberately biased towards over-bracketing:
 *     see `watchSyncOccupancy`;
 *   - one read answering several CALLERS (`noteSharedWork`), whether or not
 *     they are separate observations — the batcher cannot tell, and guessing
 *     was unsound.
 *
 * So "had the pool to itself" means "nothing THIS CAN SEE was competing", and
 * what it cannot see is everything using these connections from ANOTHER
 * CONTEXT: the sync engine in its SharedWorker, and every other tab of the same
 * workspace. That is a property of how the database is shared, not a gap in
 * this file, and it bounds what any in-tab instrument can claim.
 *
 * The qualifications fail in OPPOSITE directions, which is worth keeping
 * straight:
 *   - shared work over-reports, costing clean samples. Harmless to the figure.
 *   - work from another context under-reports, so a read queued behind it can
 *     be admitted as clean. That one can inflate the number, and it is the
 *     reason the metric is not simply conservative.
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
  private disturbancesTotal = 0
  private maxDepthSeen = 0
  private sharedWorkTotal = 0
  private uncontendedTotal = 0
  private foreignTotal = 0
  /** Bumped by `reset()`. Marks from an earlier span are not comparable to the
   *  current counters, whatever they now read. */
  private generation = 0
  private syncWatched = false
  /** Whether the database adapter is feeding `begin`/`end` at all. FALSE makes
   *  every classification below negative rather than trivially positive: an
   *  uninstrumented stack never occupies the pool, so depth is permanently zero
   *  and every read and every window would be reported as having had the
   *  database to itself. That is the one failure mode worth being loud about,
   *  and it is silent — the numbers look like a very quiet session.
   *
   *  Not stored with the samples, unlike `syncObserved`: `repoProvider` is the
   *  only place the app opens a database and it always instruments, so a record
   *  would carry a constant. The flag exists for stacks assembled by hand. */
  private poolWatched = false
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
      disturbances: this.disturbancesTotal,
      sharedWork: this.sharedWorkTotal,
    }
  }

  /** Did a call issued at `mark` wait for a connection? It did not if the pool
   *  was empty when it was issued: something arriving LATER queues behind it,
   *  not ahead of it, so its duration is its own service time whatever happens
   *  next.
   *
   *  Entry conditions ONLY, and that is the point. Judging a call on its whole
   *  life would censor it in proportion to how long it lived — a slow call has
   *  more time to be overlapped than a fast one — which biases exactly the tail
   *  these percentiles exist to report. */
  private wasUnqueued(mark: ContentionMark): boolean {
    return this.poolWatched && this.generation === mark.generation && mark.depth === 0
  }

  /** Was the OBSERVATION WINDOW opened at `mark` free of competition? A
   *  stricter question than the one above, because a resolve issues its reads
   *  over time: its later ones can queue behind traffic that arrived after it
   *  started, and one that begins just before a burst is billed for the burst.
   *
   *  So this does look at the whole window, and that carries a known cost: a
   *  long resolve is likelier to be censored than a short one, so the surviving
   *  distribution leans fast and the trend UNDER-reports a regression confined
   *  to a slow path. Accepted over the alternative — admitting burst-sized
   *  samples as clean is the defect this whole file exists to end, and it makes
   *  the metric wrong rather than conservative. */
  private isCleanWindow(mark: ContentionMark): boolean {
    return this.wasUnqueued(mark) &&
      this.disturbancesTotal === mark.disturbances &&
      this.sharedWorkTotal === mark.sharedWork
  }

  /** Open an observation window for one query resolve. Pair with
   *  `closeWindow` in a `finally`. */
  openWindow(): ContentionWindow {
    return {mark: this.currentMark()}
  }

  /** Close it, and say whether anything observable competed with it. */
  closeWindow(window: ContentionWindow): boolean {
    return this.isCleanWindow(window.mark)
  }

  /** One read answered several callers at once. Called by request coalescers
   *  (`ancestorBatch`), the only place that fact is known. Every window open
   *  across it is disqualified: N callers awaiting one statement each record
   *  its full wall-clock, which is one observation reported N times.
   *
   *  UNCONDITIONAL, and that costs something deliberately. A resolver batching
   *  many ids for its own single resolve (`core.manyAncestors`,
   *  `core.recentActivity`) is one observation whose batch is its own work, and
   *  it is disqualified anyway — so those queries keep no clean samples.
   *
   *  The alternative was to skip this when only one observation window is open,
   *  which reads window COUNT as window PARTICIPATION. That is not sound: a
   *  batch can be shared with a caller that has no window at all — `Repo.load`
   *  with `ancestors` goes through the same batcher outside any query — and
   *  then a query absorbs another caller's ids and records the enlarged
   *  duration as clean. Admitting a shared sample is the failure this whole
   *  file exists to prevent, and no amount of coverage is worth it.
   *
   *  Getting those queries back needs the coalescer to be told WHO is asking,
   *  so participation can be compared instead of counted. */
  noteSharedWork(): void {
    this.sharedWorkTotal++
  }

  /** `isCall` separates a real database call from a bracketed sync interval.
   *  Both occupy the pool and both disturb an open window; only the first is
   *  counted in `calls`, so only the first may be counted in
   *  `concurrentIssues`. */
  private enter(at: number, isCall: boolean): ContentionMark {
    const mark = this.currentMark()
    if (this.inFlight === 0) this.busySince = at
    else {
      this.disturbancesTotal++
      if (isCall) this.concurrentIssuesTotal++
    }
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
    const mark = this.enter(issuedAt, true)
    this.callsTotal++
    return {issuedAt, mark}
  }

  /** Release the connection and return the call's wall-clock, so the caller
   *  records one duration from one pair of clock reads. */
  end(ticket: ContentionTicket, kind: 'read' | 'write'): number {
    const completedAt = this.now()
    this.leave(completedAt)
    const durationMs = completedAt - ticket.issuedAt
    if (this.wasUnqueued(ticket.mark)) {
      this.uncontendedTotal++
      if (kind === 'read') this.uncontendedRead.record(durationMs)
    }
    return durationMs
  }

  /** The sync engine is working on the same connections. Occupancy only: it is
   *  bracketed from status transitions, not timed, and it bumps no call count —
   *  it is not ours to report as a db call, only to refuse to ignore. */
  beginForeign(): void {
    this.enter(this.now(), false)
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

  /** Whether database work reaches this tracker at all. Called by
   *  `instrumentAdapter`, which is the only thing that feeds `begin`/`end`. */
  observingPool(): boolean {
    return this.poolWatched
  }

  markPoolObserved(): void {
    this.poolWatched = true
  }

  /** Zero the counters and start a new span. `inFlight` IS KEPT: it tracks
   *  calls that will still call `end`, and zeroing it would drive the count
   *  negative and mis-classify everything after. Work already open settles into
   *  the new span, matching `resetMetrics`' documented behaviour for the
   *  reservoirs — but it is not JUDGED in it, which is what `generation` above
   *  enforces. */
  reset(): void {
    this.generation++
    this.busyAccruedMs = 0
    this.busySince = this.inFlight > 0 ? this.now() : null
    this.callsTotal = 0
    this.concurrentIssuesTotal = 0
    this.disturbancesTotal = 0
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

/** Establish `pool` as the tracker for `db`, and attach the feeds that belong
 *  to the DATABASE rather than to any one `Repo` reading it.
 *
 *  Called once by `repoProvider`, where the database is constructed. That is
 *  the scope both things have: a `Repo` attaching later adopts the tracker
 *  through `contentionFor`, and two Repos over one database — which
 *  `initRepo` allows, since it keys on the sync mode and `getPowerSyncDb` does
 *  not — share it. Registering the sync watcher on attach instead would give
 *  that shared tracker one listener per Repo, and every status transition would
 *  bracket the pool twice. */
export const registerContention = (db: object, pool: DbContention): void => {
  contentionByDb.set(db, pool)
  watchSyncOccupancy(db, pool)
}

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
 * The sync engine does not pass the instrumented adapter, and CANNOT be made
 * to. With `enableMultiTabs` PowerSync runs it in a SharedWorker, which takes a
 * MessagePort from `shareConnection()` and builds its own client against the
 * database worker; nothing it does reaches this tab's adapter. Its downloads
 * and uploads run on the same connections, so a read queued behind them would
 * be recorded as having had the pool to itself — the same queue-as-latency
 * defect this whole file exists to end, re-entering through the one door no
 * wrapper in this tab covers. Hence a second, worse signal.
 *
 * Transitions, not polling: a burst that begins and ends inside one resolve is
 * invisible to a status read taken at each end of it.
 *
 * THESE FLAGS ARE NOT A MEASURE OF DATABASE WORK, and the bracket is wrong in
 * BOTH directions rather than merely incomplete:
 *   - too little. The engine touches the database outside the intervals they
 *     describe — the upload path reads the CRUD queue before raising
 *     `uploading`, and updates the local target with it still clear when the
 *     queue is empty. A read landing in one of those gaps is recorded clean.
 *   - too much. `uploading` is raised for the whole of `uploadCrud`, which in
 *     this app is mostly waiting on network calls while no local connection is
 *     held at all. Windows through that wait are rejected, and the busy time
 *     and depth recorded here include it.
 *
 * Kept because the two errors are not equally bad: over-bracketing costs clean
 * samples, under-bracketing admits a queued one, and only the second makes a
 * figure wrong rather than scarce. Read the occupancy numbers as OBSERVED SYNC
 * ACTIVITY, network time and all — not as database occupancy.
 *
 * There is no better signal available from here. Instrumenting the adapter
 * (`instrumentAdapter`) fixed the layer for everything running in this tab, and
 * the sync engine is the case it does not reach: closing this would mean
 * measuring inside the shared worker, or from the database worker both sides
 * talk to.
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
  /** Which of the timings above were taken with the pool observably free, and
   *  how busy it was. Surfaced separately from `snapshot()` — the
   *  per-method record is a uniform map of `TimingSnapshot`, and its consumers
   *  iterate it.
   *
   *  PASSED IN, because the thing that feeds it is opened before any Repo
   *  exists: `repoProvider` creates the tracker, hands it to the adapter it
   *  instruments, and registers it against the database. A `DbMetrics` built
   *  without one still works and reports no clean samples at all — see
   *  `DbContention`'s `poolWatched`. */
  readonly contention: DbContention
  /** Write transactions requested on the wrapped handle and not yet settled:
   *  repo transactions, sync materialization, backfills alike. Not a metric;
   *  `reset` leaves it alone. */
  writesInFlight = 0

  constructor(contention: DbContention = new DbContention()) {
    this.contention = contention
  }

  /** ACCEPTED: the reservoirs are this Repo's, the tracker is the DATABASE's, so
   *  a reset here starts a new contention span for every Repo attached to that
   *  database while only this one's `metricsEpoch` moves. Another Repo's next
   *  snapshot can pair fresh `dbContention` with old-span `db` and `queries`.
   *  Rejected: notifying every attached Repo, which needs a per-database
   *  registry and lifetimes to serve a debug-only entry point — nothing
   *  compares contention across spans (`series.ts` reads none of it). Query
   *  windows open across the reset are discarded by `generation`, which is the
   *  conservative answer and not part of this. */
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
   *  `uncontended` (from `DbContention.closeWindow`) says nothing this tracker
   *  could see competed with the resolve for its whole life — not that nothing
   *  did. Those samples go to a SECOND reservoir as well as the first, and that
   *  one is the only per-query timing here a reader can compare across
   *  sessions: the rest move with how many other queries a surface happened to
   *  fan out alongside this one. */
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

/** One query's timings, plus the subset that ran with no OBSERVED competition.
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
  /** `options` carries the caller's lock options (a timeout, today). Typed as
   *  `unknown` and forwarded untouched: a wrapper that drops an argument it
   *  does not understand changes behaviour it was only supposed to time. */
  writeTransaction<R>(fn: (tx: TimedTxDb) => Promise<R>, options?: unknown): Promise<R>
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
 *  over the input. Intercepted: `getAll`, `getOptional`, `get`, `execute`,
 *  `writeTransaction` — timed into their own reservoirs. Every interception
 *  forwards the caller's arguments untouched, lock options included: timing a
 *  call must not change it.
 *
 *  Everything else (`onChange`, `close`, `readLock`, …) passes through to the original db,
 *  so consumers like `exportSqliteDb` that need PowerSyncDatabase-only methods
 *  keep working without us re-declaring them.
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

  /** TIMING ONLY. Occupancy is counted a layer down, by `instrumentAdapter` on
   *  the adapter PowerSync opens — the boundary every user of the connections
   *  crosses, including the ones that never reach this proxy. Bracketing here
   *  as well would count each of these calls twice, and this is also the wrong
   *  place to take the reading: every method below waits on `waitForReady`
   *  before it reaches a connection, so a mark taken here describes the pool as
   *  it was some time before the call was actually issued.
   *
   *  What this layer alone knows is WHICH CALL this is, which is why the
   *  per-method reservoirs stay. Calls made through the LockContext inside a
   *  writeTransaction are timed under their own buckets by `wrapTxDb`. */
  const timed = async <R>(reservoir: TimingReservoir, run: () => Promise<R>): Promise<R> => {
    const t0 = performance.now()
    try {
      return await run()
    } finally {
      reservoir.record(performance.now() - t0)
    }
  }

  const timedWriteTransaction = async <R>(
    fn: (tx: TimedTxDb) => Promise<R>,
    options?: unknown,
  ): Promise<R> => {
    metrics.writesInFlight++
    try {
      return await timed(metrics.writeTransaction, () =>
        db.writeTransaction(async (tx: TimedTxDb): Promise<R> => fn(wrappedTx(tx)), options))
    } finally {
      metrics.writesInFlight--
    }
  }

  const timedGetAll = <T>(sql: string, params?: unknown[]): Promise<T[]> =>
    timed(metrics.getAll, () => db.getAll<T>(sql, params))

  const timedGetOptional = <T>(sql: string, params?: unknown[]): Promise<T | null> =>
    timed(metrics.getOptional, () => db.getOptional<T>(sql, params))

  const timedGet = <T>(sql: string, params?: unknown[]): Promise<T> =>
    timed(metrics.get, () => db.get<T>(sql, params))

  const timedExecute = (sql: string, params?: unknown[]): Promise<unknown> =>
    timed(metrics.execute, () => db.execute(sql, params))

  // `writeLock` / `readLock` pass straight through. A held lock occupies a
  // connection for as long as its callback runs — the SQLite export holds one
  // across a checkpoint and a copy of the whole database — and that occupancy
  // is now recorded where the lock is actually taken, for every caller rather
  // than only the ones holding this proxy.
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
  // Also keyed by the PROXY: `contentionFor` is looked up both from the raw
  // database (by `Repo`, to find the tracker its adapter feeds) and from the
  // object a resolver holds as `ctx.db`, which is this one. Nothing else is
  // attached here — a wrapper is per-Repo, and everything that feeds the
  // tracker is per-database (see `registerContention`).
  contentionByDb.set(proxy, metrics.contention)
  return proxy
}

/** Everything a `Repo` needs to measure one database: the tracker its adapter
 *  feeds, the per-method reservoirs, and the view of the database that fills
 *  them. */
export interface MeteredDb {
  readonly metrics: DbMetrics
  readonly db: unknown
}

/**
 * Pair a database with its metrics.
 *
 * ONE CALL, because the two halves have to agree and nothing else makes them:
 * the tracker a resolver reaches through `ctx.db` and the tracker
 * `repo.metrics()` reports are the same object only if the lookup that finds it
 * and the wrapper that publishes it are given the same answer. Done separately
 * they can differ, and the failure is silent — the Repo reports a tracker
 * nothing writes to, which reads as a database that was never touched.
 *
 * A database whose adapter was never instrumented gets a tracker of its own
 * that stays unfed, and `DbContention` then declines to judge anything rather
 * than calling every sample clean.
 */
export const attachDbMetrics = (rawDb: unknown): MeteredDb => {
  const metrics = new DbMetrics(contentionFor(rawDb))
  return {metrics, db: wrapDbWithMetrics(rawDb, metrics)}
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
