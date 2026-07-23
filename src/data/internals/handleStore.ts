/**
 * HandleStore + LoaderHandle (spec §5.1, §9.1, §9.2).
 *
 * HandleStore is the central registry for `Handle<T>` instances.
 *
 *   - Identity rule: same key (`(name, stable typed serialization(args))`)
 *     → same handle instance returned from `getOrCreate`.
 *   - Ref-count GC: handles dispose `gcTimeMs` after refCount reaches zero
 *     (drained subscribers + drained in-flight loads).
 *   - Invalidation index: handles declare `Dependency`s during `resolve`;
 *     the store walks an inverted index when `invalidate(change)` fires.
 *
 * LoaderHandle is the base implementation used by Repo's collection
 * factories (`repo.children`, `repo.subtree`, etc.). It plumbs:
 *
 *   - peek / load / subscribe / read / status (the Handle<T> surface),
 *   - structural diffing (lodash.isEqual default; spec §9.4),
 *   - dependency declaration via a `ResolveContext` passed to the loader,
 *   - retain/release wiring on subscribe/unsubscribe so the store can GC.
 *
 * Block does NOT register here — it has its own row-grain subscription
 * via BlockCache.subscribe and is identity-stable through `Repo.blockFacades`.
 * The Handle interface on Block (§5.2) is a structural fit on top of those
 * existing primitives; HandleStore is the home for collection handles only.
 */

import { isEqual } from 'lodash-es'
import type { Dependency, Handle, HandleStatus, Unsubscribe } from '@/data/api'
import {
  collectPluginInvalidationsFromSnapshots,
  pluginInvalidationSize,
  type ChangeSnapshot,
  type InvalidationRule,
  type PluginInvalidationMap,
} from '@/data/invalidation.js'

/** Dependency kinds (spec §9.2). A handle whose `Dependency` matches an
 *  incoming `ChangeNotification` is invalidated and re-resolved. The
 *  concrete union lives in the public query API because query resolvers
 *  declare these deps through `QueryCtx.depend(...)`. */
export type { Dependency } from '@/data/api'

/** Set of changes the store walks against handle dependencies. The
 *  fast path (TxEngine post-commit) and the slow path (row_events tail)
 *  both produce notifications of this shape. Empty fields mean "no
 *  changes of that kind." */
export interface ChangeNotification {
  rowIds?: ReadonlySet<string> | readonly string[]
  /** Parent edges affected — for a row whose parent_id changed, BOTH
   *  the old and new parent ids appear here; for a same-parent order_key
   *  change, the parent id appears here so ordered child lists refresh
   *  (spec §9.2). */
  parentIds?: ReadonlySet<string> | readonly string[]
  workspaceIds?: ReadonlySet<string> | readonly string[]
  tables?: ReadonlySet<string> | readonly string[]
  /** Plugin-owned channel/key invalidations. Handles declare matching
   *  `{kind:'plugin', channel, key}` deps. */
  plugin?: PluginInvalidationMap
}

/** Context handed to a handle's loader. The loader calls `depend(...)`
 *  during resolve so the store can route future invalidations. */
export interface ResolveContext {
  depend(dep: Dependency): void
}

/** Loader callback shape for LoaderHandle. Receives a ResolveContext for
 *  dep declaration and returns the value the handle exposes. */
export type Loader<T> = (ctx: ResolveContext) => Promise<T>

/** Default GC delay — after refCount hits zero the handle waits this
 *  long before disposing, so a quick re-subscribe (re-render) doesn't
 *  thrash. */
const DEFAULT_GC_TIME_MS = 5_000

export interface HandleStoreOptions {
  gcTimeMs?: number
  /** Schedule GC. Default `setTimeout`; tests inject a manual scheduler. */
  schedule?: (cb: () => void, ms: number) => () => void
}

interface RegisteredHandle {
  key: string
  /** Walks deps; returns true if this handle should be invalidated. */
  matches: (change: ChangeNotification) => boolean
  /** Called by the store when an invalidation hits. The handle re-runs
   *  its loader and notifies subscribers if the value changed. When a
   *  `NotifyBatch` is passed, the handle MUST call `batch.finish(...)`
   *  exactly once for this invocation (either with a notify thunk to
   *  flush when all batch members are done, or with `null` to release
   *  its slot without contributing a notify). */
  invalidate: (batch?: NotifyBatch) => void
  /** Called when GC fires — handle clears its state, the store removes
   *  the entry from the registry. */
  dispose: () => void
  /** Called from the store when the first subscriber is added or a load
   *  starts; cancels any pending GC. */
  retain: () => void
  /** Called when the last subscriber drops or a load completes; if
   *  refCount reaches zero, schedules dispose. */
  release: () => void
  /** Called for every change that flows through `store.invalidate(...)`,
   *  regardless of whether `matches` returned true. The handle records
   *  changes that arrived while a load is in flight so they can be
   *  re-checked against the freshly-collected deps once the loader
   *  settles. No-op when the handle isn't currently loading. */
  observeDuringLoad: (change: ChangeNotification) => void
  /** Number of currently-registered Dependencies. Read by
   *  `HandleStore.snapshotInventory()` to surface fat-handle outliers
   *  without exposing the full dep list. */
  depCount: () => number
}

/** Coordinates notify-fan-out across multiple handles invalidated by the
 *  same `ChangeNotification`. Without this, each handle's loader settles
 *  on its own task and fires its notify independently; if loaders settle
 *  in different macrotasks (the common case for SQL-backed loaders), the
 *  browser can paint between them. The visible symptom on indent/move:
 *  the moved block disappears from its old parent's list, layout collapses,
 *  then it reappears under the new parent on the next paint.
 *
 *  Semantics:
 *    - Each handle invalidated as part of one `store.invalidate(...)`
 *      call registers itself with the batch via `register()` and MUST
 *      call `finish(notifyOrNull)` exactly once for that registration —
 *      with a notify thunk if it wants to fire after the barrier, or
 *      `null` to release its slot (errors, deferred-no-listeners,
 *      mid-load coalescing, structural-diff no-ops).
 *    - The barrier closes once `close()` has been called AND all
 *      registered slots have finished. At that point every queued notify
 *      runs synchronously in registration order, landing in one
 *      microtask so React 18 auto-batching captures them in one commit.
 *    - Slots that finish synchronously during the invalidate walk are
 *      drained the same way; if all matched handles short-circuit, the
 *      barrier flushes immediately on `close()`.
 *    - Mid-load handles forward `null` and don't re-register their
 *      post-settle reload into this batch; that reload's notify lands
 *      in its own microtask. The dominant indent/move case is ready
 *      handles, so the batch covers the symptom; mid-load is a
 *      best-effort fallback.
 */
class NotifyBatch {
  private remaining = 0
  private closed = false
  private flushed = false
  private readonly queue: Array<() => void> = []

  /** Reserve a slot — must be paired with exactly one `finish(...)`. */
  register(): void {
    if (this.flushed) {
      throw new Error('NotifyBatch.register after flush')
    }
    this.remaining++
  }

  /** Release a slot, optionally contributing a notify to flush when the
   *  barrier closes. Pass `null` for "no notify from this slot." */
  finish(notify: (() => void) | null): void {
    if (notify) this.queue.push(notify)
    this.remaining--
    this.maybeFlush()
  }

  /** Signal that no more `register()` calls will arrive. If the slot
   *  count is already zero this flushes immediately. */
  close(): void {
    this.closed = true
    this.maybeFlush()
  }

  private maybeFlush(): void {
    if (!this.closed || this.remaining > 0 || this.flushed) return
    this.flushed = true
    const ns = this.queue.splice(0)
    for (const n of ns) {
      try { n() } catch (err) {
        console.error('NotifyBatch flush error:', err)
      }
    }
  }
}

/** Mutable counter object for handle-related metrics (perf-baseline
 *  follow-up #4). One instance per HandleStore; LoaderHandles read it
 *  through `store.metrics` so handle-level events (loader runs,
 *  mid-load invalidations, structural-diff dedup) aggregate across the
 *  full lifetime of the store rather than being lost when handles GC.
 *
 *  Counters are plain `number` fields and increment inline; the cost
 *  is sub-nanosecond in the hot path. Snapshot via `snapshot()` for a
 *  frozen plain-object view consumers can diff between samples. */
export class HandleStoreMetrics {
  // ──── HandleStore.invalidate fan-out ────
  /** Total invalidate(...) calls that did not early-return. The
   *  empty-store + empty-change short-circuits are NOT counted (those
   *  are the cost-free path; counting them would inflate the average
   *  walk-per-call ratio). */
  invalidations = 0
  /** Total handles iterated across all invalidate calls. With the
   *  current linear walk this equals `invalidations × handles.size`
   *  on average; with the inverted-index optimisation it should drop
   *  to `handlesMatched`. Watching this in production is the fastest
   *  way to verify the optimisation has the intended effect. */
  handlesWalked = 0
  /** Total handles whose `matches(change)` returned true. */
  handlesMatched = 0

  // ──── LoaderHandle lifecycle ────
  /** Total `LoaderHandle.invalidate()` calls. Equals `handlesMatched`
   *  unless callers invalidate handles directly (e.g. tests). */
  loaderInvalidations = 0
  /** Total `runLoader()` invocations — actual loader function calls
   *  against SQL. Smaller than `loaderInvalidations` because:
   *    - mid-load invalidations are coalesced via `pendingReinvalidate`
   *      (they don't kick a fresh runLoader, they piggyback on the
   *      already-inflight settle path),
   *    - the cold `load()` from `subscribe()` also bumps this. */
  loaderRuns = 0
  /** `LoaderHandle.invalidate()` calls that arrived while a load was
   *  inflight — these flip `pendingReinvalidate` instead of starting
   *  a new runLoader. */
  midLoadInvalidations = 0
  /** Microtask-scheduled reloads triggered by `pendingReinvalidate`
   *  during the settle path. Pairs with `midLoadInvalidations` (each
   *  midLoad event eventually produces at most one reload, modulo
   *  coalescing). */
  reloadsAfterSettle = 0
  /** `notify(value)` calls where the structural diff (spec §9.4)
   *  determined the value was unchanged → listener walk skipped. */
  notifiesSkippedByDiff = 0
  /** `notify(value)` calls that actually walked the listener set. */
  notifiesFired = 0
  /** Invalidations that hit a handle with zero subscribers and no
   *  inflight load — the handle was marked stale instead of eagerly
   *  re-running its loader. The next `.load()` will re-resolve. This
   *  counter exists to verify the optimisation is firing in workloads
   *  where slow `.load()`-only queries (e.g. alias autocomplete) used
   *  to thrash on every block write. */
  loaderInvalidationsDeferred = 0
  /** ctx.depend(...) calls that registered a dep the loader had already
   *  declared in this same run — the duplicate is dropped instead of
   *  re-pushed. Drives down the matches() walk cost for handles that
   *  walk a graph and accidentally re-depend on shared nodes (e.g.
   *  many-ancestors converging on a common root). A non-zero value here
   *  is a hint that a resolver is over-registering — usually harmless,
   *  but the counter exists so we can see how much work the dedup is
   *  actually saving. */
  depsDeduplicatedAtRegistration = 0

  reset(): void {
    this.invalidations = 0
    this.handlesWalked = 0
    this.handlesMatched = 0
    this.loaderInvalidations = 0
    this.loaderRuns = 0
    this.midLoadInvalidations = 0
    this.reloadsAfterSettle = 0
    this.notifiesSkippedByDiff = 0
    this.notifiesFired = 0
    this.loaderInvalidationsDeferred = 0
    this.depsDeduplicatedAtRegistration = 0
  }

  /** Frozen plain-object snapshot. Safe to keep as a baseline for
   *  diffing — does not share state with the live counter. */
  snapshot(): Readonly<Record<string, number>> {
    return Object.freeze({
      invalidations: this.invalidations,
      handlesWalked: this.handlesWalked,
      handlesMatched: this.handlesMatched,
      loaderInvalidations: this.loaderInvalidations,
      loaderRuns: this.loaderRuns,
      midLoadInvalidations: this.midLoadInvalidations,
      reloadsAfterSettle: this.reloadsAfterSettle,
      notifiesSkippedByDiff: this.notifiesSkippedByDiff,
      notifiesFired: this.notifiesFired,
      loaderInvalidationsDeferred: this.loaderInvalidationsDeferred,
      depsDeduplicatedAtRegistration: this.depsDeduplicatedAtRegistration,
    })
  }
}

/** Identity-stable registry of handles. */
export class HandleStore {
  private readonly handles = new Map<string, RegisteredHandle>()
  private readonly gcTimeMs: number
  private readonly schedule: (cb: () => void, ms: number) => () => void
  /** Metrics counters. LoaderHandle bumps handle-level fields through
   *  this same object so all aggregates share one snapshot. */
  readonly metrics = new HandleStoreMetrics()

  constructor(opts?: HandleStoreOptions) {
    this.gcTimeMs = opts?.gcTimeMs ?? DEFAULT_GC_TIME_MS
    this.schedule =
      opts?.schedule ??
      ((cb, ms) => {
        const t = setTimeout(cb, ms)
        return () => clearTimeout(t)
      })
  }

  /** Returns the GC delay in ms (used by LoaderHandle for its own
   *  scheduling). */
  getGcTimeMs(): number { return this.gcTimeMs }

  getScheduler(): (cb: () => void, ms: number) => () => void { return this.schedule }

  /** Get-or-create. Identity rule: same key → same instance. */
  getOrCreate<T extends RegisteredHandle>(key: string, factory: () => T): T {
    const existing = this.handles.get(key)
    if (existing) return existing as T
    const created = factory()
    this.handles.set(key, created)
    return created
  }

  /** Remove a key (called by the handle itself on dispose). */
  remove(key: string): void { this.handles.delete(key) }

  /** Walk all registered handles, invalidate the ones whose deps match. */
  invalidate(change: ChangeNotification): void {
    if (this.handles.size === 0) return
    if (
      (!change.rowIds || sizeOf(change.rowIds) === 0) &&
      (!change.parentIds || sizeOf(change.parentIds) === 0) &&
      (!change.workspaceIds || sizeOf(change.workspaceIds) === 0) &&
      (!change.tables || sizeOf(change.tables) === 0) &&
      pluginInvalidationSize(change.plugin) === 0
    ) {
      return
    }
    // Snapshot the handle list — invalidate() may resolve synchronously
    // in tests and trigger further changes; iterating a stable snapshot
    // keeps that bounded.
    //
    // Order matters (reviewer P2 #3): observeDuringLoad MUST run before
    // invalidate. observeDuringLoad gates on `inflight` — if we invalidate
    // first on a ready handle, the loader spins up and inflight becomes
    // truthy, causing observeDuringLoad to record the same change in the
    // queue. After the freshly-kicked-off load settles, the queued change
    // matches the freshly-collected deps and schedules ANOTHER load even
    // though the first reload already covered the change. Running
    // observeDuringLoad first means ready handles skip the queue (correct:
    // their fresh load already accounts for this change) while loading
    // handles record the change for post-settle replay (correct: needed
    // for late-declared deps to catch the change).
    this.metrics.invalidations++
    const snapshot = Array.from(this.handles.values())
    // First pass — observeDuringLoad for every handle, and collect the
    // matched set. We need the matched count before deciding whether to
    // open a batch (a single-handle invalidation has nothing to
    // coordinate and skips the barrier machinery).
    const matched: RegisteredHandle[] = []
    for (const h of snapshot) {
      this.metrics.handlesWalked++
      h.observeDuringLoad(change)
      if (h.matches(change)) {
        this.metrics.handlesMatched++
        matched.push(h)
      }
    }
    if (matched.length <= 1) {
      for (const h of matched) h.invalidate()
      return
    }
    // ≥2 matched handles — coordinate their notifies so they all land in
    // one microtask once the slowest loader settles. Without this, the
    // moved-block flicker during indent/move: each parent's childIds
    // handle settles on its own SQL response, paints between them.
    const batch = new NotifyBatch()
    for (const h of matched) {
      batch.register()
      h.invalidate(batch)
    }
    batch.close()
  }

  /** Test/debug: how many handles are currently registered. */
  size(): number { return this.handles.size }

  /** Snapshot of live-state aggregates over registered handles. Pairs
   *  with `metrics.snapshot()` (counters) to give a complete read on
   *  the store with one call. Use this to find fat-handle outliers
   *  (resolvers declaring lots of deps) without having to walk
   *  `this.handles` from a devtools eval.
   *
   *  `topHeavy` is the K=3 handles with the most deps. Three is enough
   *  to spot a pattern (one outlier vs a cluster) and small enough to
   *  surface in a log line. */
  snapshotInventory(): Readonly<{
    handleCount: number
    totalDeps: number
    maxDeps: number
    p50Deps: number
    p95Deps: number
    topHeavy: ReadonlyArray<Readonly<{key: string; depCount: number}>>
  }> {
    const counts: Array<{key: string; depCount: number}> = []
    let totalDeps = 0
    let maxDeps = 0
    for (const [key, h] of this.handles) {
      const n = h.depCount()
      counts.push({key, depCount: n})
      totalDeps += n
      if (n > maxDeps) maxDeps = n
    }
    const sortedDescByDepCount = counts.slice().sort((a, b) => b.depCount - a.depCount)
    const topHeavy = Object.freeze(
      sortedDescByDepCount.slice(0, 3).map(c => Object.freeze({...c})),
    )
    const sortedAsc = counts.map(c => c.depCount).sort((a, b) => a - b)
    return Object.freeze({
      handleCount: counts.length,
      totalDeps,
      maxDeps,
      p50Deps: nearestRankPercentile(sortedAsc, 50),
      p95Deps: nearestRankPercentile(sortedAsc, 95),
      topHeavy,
    })
  }

  /** Dispose every handle (test cleanup). */
  clear(): void {
    const snapshot = Array.from(this.handles.values())
    for (const h of snapshot) h.dispose()
    this.handles.clear()
  }
}

const sizeOf = (xs: ReadonlySet<string> | readonly string[]): number =>
  xs instanceof Set ? xs.size : (xs as readonly string[]).length

/** Nearest-rank percentile over an ascending-sorted, non-empty array.
 *  Returns 0 for an empty input so callers don't need a guard. */
const nearestRankPercentile = (sortedAsc: readonly number[], p: number): number => {
  if (sortedAsc.length === 0) return 0
  const rank = Math.ceil((p / 100) * sortedAsc.length)
  return sortedAsc[Math.min(sortedAsc.length - 1, Math.max(0, rank - 1))]
}

/** Generic loader-backed handle. The collection factories (`repo.children`,
 *  `repo.subtree`, etc.) construct one of these with a key + loader. */
export class LoaderHandle<T> implements Handle<T>, RegisteredHandle {
  readonly key: string

  private readonly store: HandleStore
  private readonly loader: Loader<T>
  private readonly equality: (a: T, b: T) => boolean

  private value: T | undefined = undefined
  private notifiedValue: T | undefined = undefined
  private hasNotifiedValue = false
  private status_: HandleStatus = 'idle'
  private error: unknown = undefined

  // eslint-disable-next-line callback-set/prefer-callback-set -- kernel hot path: this set is wrapped in handle-specific notify bookkeeping (structural-diff dedup via notifiedValue/equality, batch coalescing, metrics counters). notify() already snapshots + isolates listener errors exactly like CallbackSet, so a swap would replace only the ~6-line dispatch loop while coupling the kernel to the util — no behavioral gain.
  private readonly listeners = new Set<(value: T) => void>()
  private deps: Dependency[] = []

  /** Inflight `load()` promise — dedup'd. Cleared once it settles. */
  private inflight: Promise<T> | null = null
  /** Suspense throw target — same as `inflight` while loading; let the
   *  caller `await` the same promise React threw. */
  private suspendingPromise: Promise<T> | null = null

  /** Ref count = subscribers + inflight (1 if loading). Drives GC. */
  private refCount = 0
  private cancelGc: (() => void) | null = null
  private disposed = false

  /** Set when `invalidate()` fires while a load is in flight. The
   *  inflight load may have already read stale data from SQL before the
   *  invalidating commit landed, so its result cannot be trusted on
   *  its own. We let the load settle (so the suspending promise React
   *  is awaiting still resolves) and immediately re-run the loader to
   *  pick up the post-invalidation state. */
  private pendingReinvalidate = false

  /** Changes observed while this load is in flight. Recorded
   *  unconditionally (not gated on `matches`) so deps that the loader
   *  declares LATER — e.g. per-row deps published by `hydrateRows` after
   *  SQL returns — can be checked against the queue once the loader
   *  settles. Without this, a child-row commit landing between SQL
   *  read and per-row `ctx.depend(...)` would slip past `matches`
   *  (only the upfront `parent-edge` dep is known at that point) and
   *  the handle would settle with stale `BlockData[]`. */
  private changesDuringLoad: ChangeNotification[] = []

  /** Set when an invalidation lands on a handle with zero subscribers
   *  and no inflight load. Eagerly re-running the loader for nobody is
   *  pure waste — and worse, the run blocks write transactions on the
   *  same SQLite connection (alias-autocomplete saw ~640ms reads
   *  pacing block-creation writes). Instead we mark stale; the next
   *  `.load()` bypasses the cached-value short-circuit and re-resolves.
   *  Subscribed handles ignore this flag — they still re-run eagerly
   *  so listeners stay in sync. */
  private stale = false

  constructor(args: {
    store: HandleStore
    key: string
    loader: Loader<T>
    /** Optional custom equality; defaults to lodash.isEqual (spec §9.4). */
    equality?: (a: T, b: T) => boolean
  }) {
    this.store = args.store
    this.key = args.key
    this.loader = args.loader
    this.equality = args.equality ?? isEqual
    // A handle is inserted into the store by `getOrCreate` BEFORE anything
    // retains it. `release()` (the only other GC scheduler) is never reached
    // for a handle that is never loaded/subscribed, so without this an idle
    // handle would live forever — e.g. an abandoned React concurrent-render
    // lookup whose subscribe effect never commits, or a query handle left
    // orphaned at an old key by a registry-epoch bump. Schedule the normal
    // gcTimeMs sweep now; the first `retain()` (load/subscribe) cancels it.
    // (Skip for gcTimeMs<=0: that's the synchronous-dispose test config, and
    // disposing here would race `getOrCreate`'s not-yet-inserted entry.)
    const gcMs = this.store.getGcTimeMs()
    if (gcMs > 0) {
      this.cancelGc = this.store.getScheduler()(() => this.dispose(), gcMs)
    }
  }

  // ──── Handle<T> surface ────

  peek(): T | undefined { return this.value }

  status(): HandleStatus { return this.status_ }

  load(): Promise<T> {
    if (this.disposed) {
      return Promise.reject(new Error(`Handle ${this.key} has been disposed`))
    }
    // An inflight load means the cached value is *known stale* — it was
    // either never set (cold load) or was invalidated and a fresh fetch
    // is in progress. Return the inflight so awaiters see post-
    // invalidation truth. Callers who specifically want "give me the
    // current cached value, don't wait" should use `peek()`. Without
    // this preference, a `repo.tx` → `handleStore.invalidate(...)`
    // sequence can hand the next `await handle.load()` a pre-commit
    // snapshot — e.g. a processor reading a query handle right after a
    // commit that just tombstoned the looked-up row would see it as
    // live and skip the restore (references.parseReferences §7.5 race).
    if (this.inflight) return this.inflight
    if (this.status_ === 'ready' && this.value !== undefined && !this.stale) {
      return Promise.resolve(this.value)
    }
    return this.runLoader()
  }

  /** Resolve only after the handle has no known stale or in-flight follow-up
   * load. Unlike `load()`, this does not expose a result that was invalidated
   * while its loader was running. Projector priming uses this completeness
   * boundary so a cached or superseded snapshot cannot release writes. */
  async loadFresh(): Promise<T> {
    while (true) {
      await this.load()
      // A dirty settle schedules its follow-up reload in a microtask before
      // resolving the load promise. Yield once so that reload becomes visible.
      await Promise.resolve()
      if (this.inflight || this.stale) continue
      if (this.value === undefined) {
        throw new Error(`Handle ${this.key} completed without a value`)
      }
      return this.value
    }
  }

  /** Actually run the loader. Skips the cached-value short-circuit; used
   *  by `load()` (cold path) and `invalidate()` (force re-resolve).
   *
   *  Dep visibility during the load:
   *    - Each `ctx.depend(dep)` call is published to `this.deps`
   *      immediately so a mid-load `invalidate({…})` can match
   *      upfront-declared deps even before the loader awaits SQL.
   *    - On load success we replace `this.deps` with the freshly-
   *      collected list (drops any deps from the prior resolve that
   *      this resolve didn't re-declare).
   *    - On load failure we restore the prior deps so the next attempt
   *      still has a sensible matching baseline. */
  private runLoader(batch?: NotifyBatch): Promise<T> {
    // Reset pending-reinvalidate at run start. Anything that arrives
    // during this run sets the flag; we re-run after settle. Same for
    // the queue of changes recorded against post-load deps.
    this.store.metrics.loaderRuns++
    this.pendingReinvalidate = false
    this.changesDuringLoad = []
    this.stale = false
    this.status_ = this.value === undefined ? 'loading' : this.status_
    this.error = undefined
    this.retain() // count the inflight load against GC

    // Snapshot the prior deps so we can restore them if this load
    // fails; meanwhile this.deps is rewritten as ctx.depend calls land,
    // starting from a shallow copy of the prior deps. The starting
    // copy keeps prior-resolution invalidation matches valid during
    // the brief window before the loader has declared anything.
    const priorDeps = this.deps
    this.deps = priorDeps.slice()
    const collected: Dependency[] = []
    // Dedup ctx.depend(...) calls against the keys already collected
    // this run. A resolver that walks a DAG (e.g. manyAncestors
    // converging on a shared workspace-root id from many sources) can
    // call ctx.depend with the same dep dozens of times; without dedup
    // each duplicate inflates the matches() walk cost on future
    // invalidations. `priorKeys` lets the live this.deps publish skip
    // entries priorDeps already contains, so this.deps stays a deduped
    // union of prior + new collected during the load window.
    const collectedKeys = new Set<string>()
    const priorKeys = new Set<string>()
    for (const d of priorDeps) priorKeys.add(depKey(d))
    const onDep = (dep: Dependency) => {
      const k = depKey(dep)
      if (collectedKeys.has(k)) {
        this.store.metrics.depsDeduplicatedAtRegistration++
        return
      }
      collectedKeys.add(k)
      collected.push(dep)
      // Live-publish so mid-load matches() sees the new dep — but only
      // if priorDeps didn't already carry it.
      if (!priorKeys.has(k)) this.deps.push(dep)
    }
    const ctx: ResolveContext = {
      depend(dep: Dependency) { onDep(dep) },
    }

    const p = this.loader(ctx).then(
      (value) => {
        // Disposal during a load: don't apply, don't notify.
        if (this.disposed) throw new Error(`Handle ${this.key} disposed mid-load`)
        // Replace live deps with the freshly-collected set (drops any
        // priorDeps the loader didn't re-declare).
        this.deps = collected
        // Re-walk the queued changes against the now-final dep set.
        // Any change that arrived after a row dep was published will
        // already have flipped `pendingReinvalidate` via `invalidate()`;
        // this step covers the OPPOSITE order — change first, dep
        // second — which `matches` couldn't see at the time.
        if (!this.pendingReinvalidate) {
          for (const change of this.changesDuringLoad) {
            if (this.matchesAgainst(collected, change)) {
              this.pendingReinvalidate = true
              break
            }
          }
        }
        this.changesDuringLoad = []
        const needsPostSettleReload = this.pendingReinvalidate && !this.disposed
        this.value = value
        this.status_ = 'ready'
        this.error = undefined
        this.inflight = null
        this.suspendingPromise = null
        // Structural-diff against the last value subscribers actually saw,
        // not merely the internal cache. A dirty mid-load result may update
        // `value` for peek/load callers, but it must not consume the clean
        // rerun's notification if both results are equal.
        const willNotify =
          !this.hasNotifiedValue || !this.equality(this.notifiedValue as T, value)
        if (needsPostSettleReload) {
          // The promise returned by this load may resolve with the value it
          // read, but subscribers should not rebuild from a snapshot already
          // known suspect. The queued reload below will publish the clean
          // value if it differs from the last value subscribers saw.
          batch?.finish(null)
        } else if (willNotify) {
          // When this load was kicked off by a batched invalidate,
          // queue the notify so it lands in the same microtask as the
          // other batch members' notifies (one React commit). Without
          // a batch, fire immediately as before.
          if (batch) batch.finish(() => this.notify(value))
          else this.notify(value)
        } else {
          // Equality match against prior value: notify suppressed.
          // Counts even when the listener set is empty — the dedup
          // decision happened, we measure the decision, not the walk.
          this.store.metrics.notifiesSkippedByDiff++
          batch?.finish(null)
        }
        this.release() // drop the inflight ref
        // If invalidations arrived during this load, the data we just
        // returned may already be stale. Re-run via a microtask so the
        // promise that React awaited can resolve first — but only if
        // someone is actually subscribed. With zero listeners, mark
        // stale and skip the reload; the next `.load()` will re-resolve
        // off the stale flag, and we save a slow query (and the
        // SQLite-connection contention it causes) when nobody cares.
        if (needsPostSettleReload) {
          this.pendingReinvalidate = false
          if (this.listeners.size === 0) {
            this.stale = true
            this.store.metrics.loaderInvalidationsDeferred++
          } else {
            this.store.metrics.reloadsAfterSettle++
            queueMicrotask(() => {
              if (this.disposed) return
              // No-op if a fresher load is already in flight (subscribe
              // path or another invalidate scheduled it).
              if (this.inflight) return
              void this.runLoader().catch(() => {/* error on handle */})
            })
          }
        }
        return value
      },
      (err) => {
        // Release the batch slot unconditionally — including the
        // disposed-mid-load case (where the success path throws into
        // here). The barrier must not hang on a vanished participant.
        // Failed loads contribute no notify; the prior notify, if any,
        // already fired on the last successful settle.
        batch?.finish(null)
        if (!this.disposed) {
          // Roll back to the priorDeps — collected was incomplete.
          // The queued changes are discarded along with the partial
          // deps; a successful retry will rebuild both from scratch.
          this.deps = priorDeps
          this.changesDuringLoad = []
          this.status_ = 'error'
          this.error = err
          this.inflight = null
          this.suspendingPromise = null
          this.release()
          // A pending reinvalidate against an errored load is still
          // worth honoring — the state changed, and the next attempt
          // may succeed. But if nobody is subscribed, mark stale and
          // defer the retry to the next `.load()` (same reasoning as
          // the success path).
          if (this.pendingReinvalidate) {
            this.pendingReinvalidate = false
            if (this.listeners.size === 0) {
              this.stale = true
              this.store.metrics.loaderInvalidationsDeferred++
            } else {
              this.store.metrics.reloadsAfterSettle++
              queueMicrotask(() => {
                if (this.disposed) return
                if (this.inflight) return
                void this.runLoader().catch(() => {/* error on handle */})
              })
            }
          }
        }
        throw err
      },
    )
    this.inflight = p
    this.suspendingPromise = p
    return p
  }

  subscribe(listener: (value: T) => void): Unsubscribe {
    if (this.disposed) {
      // Listening to a disposed handle is a no-op + immediate
      // unsubscribe; callers should re-acquire via the factory.
      return () => {}
    }
    this.listeners.add(listener)
    this.retain()
    // First subscriber kicks off a load if we're idle, OR if the handle
    // was marked stale while sitting at refCount=0 (a deferred
    // invalidation skipped the eager reload). Without this, the new
    // subscriber would only ever see the stale cached value via
    // peek()/read() — load()'s stale check fixes the await-path, but
    // subscribers depend on the eager push, so we trigger a refresh
    // here too.
    if ((this.status_ === 'idle' || this.stale) && !this.inflight) {
      void this.load().catch(() => {/* error stored on the handle */})
    }
    return () => {
      if (!this.listeners.delete(listener)) return
      this.release()
    }
  }

  read(): T {
    if (this.status_ === 'ready' && this.value !== undefined) return this.value
    if (this.status_ === 'error') throw this.error
    // Suspense path: throw a promise React can `await`.
    if (this.suspendingPromise) throw this.suspendingPromise
    // Idle: kick off a load and throw the resulting promise.
    throw this.load()
  }

  // ──── RegisteredHandle surface (HandleStore-facing) ────

  matches(change: ChangeNotification): boolean {
    return this.matchesAgainst(this.deps, change)
  }

  private matchesAgainst(deps: readonly Dependency[], change: ChangeNotification): boolean {
    if (deps.length === 0) return false
    for (const dep of deps) {
      if (matchesDep(dep, change)) return true
    }
    return false
  }

  depCount(): number { return this.deps.length }

  observeDuringLoad(change: ChangeNotification): void {
    // Only worth recording while a load is actually in flight.
    // Capacity isn't bounded by design — invalidations are infrequent
    // relative to load duration, and the queue clears on every settle.
    if (this.inflight) this.changesDuringLoad.push(change)
  }

  invalidate(batch?: NotifyBatch): void {
    if (this.disposed) {
      batch?.finish(null)
      return
    }
    this.store.metrics.loaderInvalidations++
    // Force a re-resolve. Readers calling `peek()` see the stale value
    // until the new load completes — status stays 'ready' so the UI
    // doesn't flash a Suspense fallback for in-place updates. Readers
    // calling `load()` get the inflight reload (post-invalidation
    // truth) — see the load()-prefers-inflight comment above.
    if (this.inflight) {
      // A load is already running; it may have read stale data from
      // SQL before the invalidating commit landed. Mark the run as
      // dirty so runLoader's settle path schedules another pass once
      // the current promise resolves. Multiple invalidations during
      // one load coalesce into a single rerun (the next loader picks
      // up the latest state in one go).
      //
      // Batch semantics: mid-load handles release their slot without
      // contributing a notify. The post-settle reload's notify lands
      // in its own microtask, outside this batch — acceptable because
      // the common indent/move case is ready handles, not mid-load.
      this.store.metrics.midLoadInvalidations++
      this.pendingReinvalidate = true
      batch?.finish(null)
      return
    }
    // No subscribers waiting on push notifications? Don't burn a slow
    // SQL query for nobody. Mark stale; the next `.load()` will see
    // the flag and re-resolve. This is what keeps a stale-but-still-
    // GC-window-alive `aliasesInWorkspace` handle from reloading on
    // every block write the user makes after closing autocomplete.
    if (this.listeners.size === 0) {
      this.stale = true
      this.store.metrics.loaderInvalidationsDeferred++
      batch?.finish(null)
      return
    }
    void this.runLoader(batch).catch(() => {/* error on handle */})
  }

  retain(): void {
    if (this.disposed) return
    this.refCount++
    if (this.cancelGc) {
      this.cancelGc()
      this.cancelGc = null
    }
  }

  release(): void {
    if (this.disposed) return
    if (this.refCount === 0) return
    this.refCount--
    if (this.refCount === 0) {
      const gcMs = this.store.getGcTimeMs()
      if (gcMs <= 0) {
        this.dispose()
        return
      }
      this.cancelGc = this.store.getScheduler()(() => this.dispose(), gcMs)
    }
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    if (this.cancelGc) {
      this.cancelGc()
      this.cancelGc = null
    }
    this.listeners.clear()
    this.deps = []
    this.changesDuringLoad = []
    this.value = undefined
    this.notifiedValue = undefined
    this.hasNotifiedValue = false
    this.status_ = 'idle'
    this.inflight = null
    this.suspendingPromise = null
    this.store.remove(this.key)
  }

  // ──── private ────

  private notify(value: T): void {
    if (this.listeners.size === 0) return
    this.notifiedValue = value
    this.hasNotifiedValue = true
    this.store.metrics.notifiesFired++
    // Snapshot listeners — a listener may unsubscribe during dispatch.
    const snapshot = Array.from(this.listeners)
    for (const fn of snapshot) {
      try { fn(value) } catch (err) {
        // Listener errors must not break dispatch; surface via console.
        console.error(`HandleStore listener error on ${this.key}:`, err)
      }
    }
  }

  /** Test-only: snapshot of declared dependencies. */
  __depsForTest(): readonly Dependency[] { return this.deps }
}

/** Canonical key for a `Dependency` used by the registration-time dedup
 *  in `LoaderHandle.runLoader`. Two deps that produce the same key are
 *  invalidation-equivalent: they match exactly the same set of
 *  `ChangeNotification`s. SEP is `\x00` to avoid collisions between
 *  fields (a channel literally named `"row"` won't collide with a row
 *  dep's id). */
const depKey = (dep: Dependency): string => {
  switch (dep.kind) {
    case 'row': return `row\x00${dep.id}`
    case 'parent-edge': return `pe\x00${dep.parentId}`
    case 'workspace': return `ws\x00${dep.workspaceId}`
    case 'table': return `tbl\x00${dep.table}`
    case 'plugin': return `p\x00${dep.channel}\x00${dep.key}`
  }
}

const matchesDep = (dep: Dependency, change: ChangeNotification): boolean => {
  switch (dep.kind) {
    case 'row':
      return change.rowIds ? has(change.rowIds, dep.id) : false
    case 'parent-edge':
      return change.parentIds ? has(change.parentIds, dep.parentId) : false
    case 'workspace':
      return change.workspaceIds ? has(change.workspaceIds, dep.workspaceId) : false
    case 'table':
      return change.tables ? has(change.tables, dep.table) : false
    case 'plugin': {
      const keys = change.plugin?.get(dep.channel)
      return keys ? has(keys, dep.key) : false
    }
  }
}

const has = (xs: ReadonlySet<string> | readonly string[], target: string): boolean => {
  if (xs instanceof Set) return xs.has(target)
  for (const x of xs) if (x === target) return true
  return false
}

/** Stable args→key serializer. Object keys are sorted so `{a:1,b:2}`
 *  and `{b:2,a:1}` yield the same key, while type tags preserve
 *  otherwise JSON-colliding values such as omitted vs undefined fields
 *  and Date instances vs ISO strings. */
type StableKeyValue =
  | readonly ['undefined']
  | readonly ['null']
  | readonly ['boolean', boolean]
  | readonly ['number', number | string]
  | readonly ['bigint', string]
  | readonly ['string', string]
  | readonly ['date', string]
  | readonly ['array', readonly StableKeyValue[]]
  | readonly ['object', readonly (readonly [string, StableKeyValue])[]]

const stableKeyValue = (
  value: unknown,
  seen: WeakSet<object>,
): StableKeyValue => {
  if (value === undefined) return ['undefined']
  if (value === null) return ['null']
  if (typeof value === 'boolean') return ['boolean', value]
  if (typeof value === 'string') return ['string', value]
  if (typeof value === 'bigint') return ['bigint', value.toString()]
  if (typeof value === 'number') {
    if (Number.isNaN(value)) return ['number', 'NaN']
    if (Object.is(value, -0)) return ['number', '-0']
    if (value === Infinity) return ['number', 'Infinity']
    if (value === -Infinity) return ['number', '-Infinity']
    return ['number', value]
  }
  if (typeof value === 'function' || typeof value === 'symbol') {
    throw new Error(`[handleKey] unsupported query arg value type: ${typeof value}`)
  }

  if (value instanceof Date) {
    return ['date', Number.isNaN(value.getTime()) ? 'Invalid Date' : value.toISOString()]
  }

  if (seen.has(value)) {
    throw new Error('[handleKey] cannot key cyclic query args')
  }
  seen.add(value)
  try {
    if (Array.isArray(value)) {
      return ['array', value.map(item => stableKeyValue(item, seen))]
    }

    const obj = value as Record<string, unknown>
    return [
      'object',
      Object.keys(obj)
        .sort()
        .map(key => [key, stableKeyValue(obj[key], seen)] as const),
    ]
  } finally {
    seen.delete(value)
  }
}

export const stableArgsKey = (args: unknown): string =>
  JSON.stringify(stableKeyValue(args, new WeakSet()))

/** Compose a Handle key from a name + optional args. Used by Repo
 *  factories to construct identity-stable keys. */
export const handleKey = (name: string, args?: unknown): string =>
  args === undefined ? name : `${name}:${stableArgsKey(args)}`

/** Per-id snapshot pair shape. Mirrors `SnapshotEntry` from
 *  `txSnapshots.ts` without importing it (handleStore stays free of
 *  internals dependencies). */
export type { ChangeSnapshot } from '@/data/invalidation.js'

/** Compute a `ChangeNotification` from a tx's per-id snapshots map.
 *  Used by the TxEngine fast path (§9.3): post-commit, the engine
 *  passes its snapshots map here and feeds the result into
 *  `handleStore.invalidate(...)`.
 *
 *  Rules:
 *    - `rowIds`: every id touched by the tx (any field change is enough
 *       to invalidate row deps).
 *    - `parentIds`: union of `before.parentId` / `after.parentId` when
 *       the row's *membership* in a parent's live-children set changed
 *       (creation, soft-deletion, restore, parent move), or the live
 *       sibling order changed under the same parent (`order_key` update).
 *       Also adds `before.parentId` AND the row's own `id` whenever its
 *       `referenceTargetId` changed (field-row recognition flip): the
 *       parent's VISIBLE membership and the row's own visible children
 *       both shift (§9). Pure content / property edits otherwise don't
 *       fire parent-edge deps.
 *    - `workspaceIds`: every workspace_id touched (covers backlinks
 *       handles' coarse workspace dep).
 *    - `plugin`: channel/key invalidations emitted by plugin rules.
 *
 *  Note: `tables` is intentionally NOT auto-emitted. The `kind:'table'`
 *  dep mechanism is still wired through `handleStore.invalidate(...)`,
 *  but no production query depends on it — auto-emitting `['blocks']`
 *  on every commit walked the channel for nothing. A plugin that
 *  genuinely needs a coarse-table fallback should call
 *  `handleStore.invalidate({tables: [...]})` directly, or (better)
 *  contribute an `InvalidationRule` that emits a narrow plugin channel.
 */
export const snapshotsToChangeNotification = (
  snapshots: ReadonlyMap<string, ChangeSnapshot>,
  invalidationRules: readonly InvalidationRule[] = [],
): ChangeNotification => {
  const rowIds = new Set<string>()
  const parentIds = new Set<string>()
  const workspaceIds = new Set<string>()
  for (const [id, entry] of snapshots) {
    rowIds.add(id)
    if (entry.before?.workspaceId) workspaceIds.add(entry.before.workspaceId)
    if (entry.after?.workspaceId) workspaceIds.add(entry.after.workspaceId)

    const beforeParent = entry.before?.parentId ?? null
    const afterParent = entry.after?.parentId ?? null
    const beforeOrderKey = entry.before?.orderKey
    const afterOrderKey = entry.after?.orderKey
    const beforeLive = !!entry.before && !entry.before.deleted
    const afterLive = !!entry.after && !entry.after.deleted

    // Created (no prior live row → now live somewhere): the new
    // parent gains a child.
    if (!beforeLive && afterLive && afterParent !== null) {
      parentIds.add(afterParent)
    }
    // Soft-deleted (prior live → now tombstoned): the prior parent
    // loses a child.
    else if (beforeLive && !afterLive && beforeParent !== null) {
      parentIds.add(beforeParent)
    }
    // Moved (live both sides, parent changed): both sides update.
    else if (beforeLive && afterLive && beforeParent !== afterParent) {
      if (beforeParent !== null) parentIds.add(beforeParent)
      if (afterParent !== null) parentIds.add(afterParent)
    }
    // Reordered in place (live both sides, same parent): ordered
    // child-id lists depend on `(order_key, id)`, so the parent handle
    // must re-resolve even though membership did not change.
    else if (
      beforeLive
      && afterLive
      && beforeParent !== null
      && beforeOrderKey !== afterOrderKey
    ) {
      parentIds.add(beforeParent)
    }
    // Field-row recognition flipped in place (live both sides, same
    // parent, `referenceTargetId` changed): in a child-backed workspace
    // the VISIBLE child set default-excludes recognized field rows
    // (PR #288 §9), so a row becoming/ceasing to be a field row changes
    // the parent's visible membership even though the tree edge didn't.
    // Un-flipped workspaces get a rare spurious re-resolve (content edits
    // to/from whole-block references) — harmless.
    else if (
      beforeLive
      && afterLive
      && beforeParent !== null
      && (entry.before?.referenceTargetId ?? null) !== (entry.after?.referenceTargetId ?? null)
    ) {
      parentIds.add(beforeParent)
    }
    // Pure field change with same parent_id and same liveness: rowId
    // alone covers it. No parent-edge entry — `repo.children(id)`
    // already declares row deps on each child for this case.

    // Independent of the membership transition above (NOT chained with
    // `else if`): whenever a live row's `referenceTargetId` changes,
    // `children(id)` must also re-resolve — `id` flipping field-row-ness
    // toggles whether its OWN children are property-subtree interior (a
    // child that resolves to a definition is EXCLUDED from `children(id)`
    // while `id` is a normal row but SHOWN as a value once `id` is a field
    // row, §9). This holds even when the row ALSO moved in the same tx —
    // e.g. `mergeBlocksInTx` clears a value's stamp AND relocates it in one
    // commit, which matches the mutually-exclusive "Moved" branch above; a
    // chained `else if` would then swallow this self-edge and strand a
    // `children(id)` handle stale.
    if (
      beforeLive
      && afterLive
      && (entry.before?.referenceTargetId ?? null) !== (entry.after?.referenceTargetId ?? null)
    ) {
      parentIds.add(id)
    }

  }
  return {
    rowIds,
    parentIds,
    workspaceIds,
    plugin: collectPluginInvalidationsFromSnapshots(invalidationRules, snapshots),
  }
}
