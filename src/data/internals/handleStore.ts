/**
 * HandleStore + LoaderHandle (spec §5.1, §9.1, §9.2).
 *
 * HandleStore is the central registry for `Handle<T>` instances.
 *
 *   - Identity rule: same key (`(name, JSON.stringify(args))`) → same handle
 *     instance returned from `getOrCreate`.
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

import { isEqual } from 'lodash'
import type { Handle, HandleStatus, Unsubscribe } from '@/data/api'

/** Dependency kinds (spec §9.2). A handle whose `Dependency` matches an
 *  incoming `ChangeNotification` is invalidated and re-resolved. */
export type Dependency =
  | { kind: 'row'; id: string }
  | { kind: 'parent-edge'; parentId: string }
  | { kind: 'workspace'; workspaceId: string }
  | { kind: 'table'; table: string }
  | { kind: 'backlink-target'; id: string }

/** Set of changes the store walks against handle dependencies. The
 *  fast path (TxEngine post-commit) and the slow path (row_events tail)
 *  both produce notifications of this shape. Empty fields mean "no
 *  changes of that kind." */
export interface ChangeNotification {
  rowIds?: ReadonlySet<string> | readonly string[]
  /** Parent edges affected — for a row whose parent_id changed, BOTH
   *  the old and new parent ids appear here (spec §9.2). */
  parentIds?: ReadonlySet<string> | readonly string[]
  workspaceIds?: ReadonlySet<string> | readonly string[]
  tables?: ReadonlySet<string> | readonly string[]
  /** Target ids whose incoming-edge set changed — i.e. some block in
   *  the workspace gained or lost a reference pointing at this id.
   *  Computed as the symmetric difference of `references_json` target
   *  ids per touched row (with soft-delete / restore treated as
   *  "all edges" lost / gained respectively). Drives `backlink-target`
   *  deps. Empty for tx batches that didn't change any references. */
  backlinkTargets?: ReadonlySet<string> | readonly string[]
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
   *  its loader and notifies subscribers if the value changed. */
  invalidate: () => void
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
      (!change.backlinkTargets || sizeOf(change.backlinkTargets) === 0)
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
    for (const h of snapshot) {
      this.metrics.handlesWalked++
      h.observeDuringLoad(change)
      if (h.matches(change)) {
        this.metrics.handlesMatched++
        h.invalidate()
      }
    }
  }

  /** Test/debug: how many handles are currently registered. */
  size(): number { return this.handles.size }

  /** Dispose every handle (test cleanup). */
  clear(): void {
    const snapshot = Array.from(this.handles.values())
    for (const h of snapshot) h.dispose()
    this.handles.clear()
  }
}

const sizeOf = (xs: ReadonlySet<string> | readonly string[]): number =>
  xs instanceof Set ? xs.size : (xs as readonly string[]).length

/** Generic loader-backed handle. The collection factories (`repo.children`,
 *  `repo.subtree`, etc.) construct one of these with a key + loader. */
export class LoaderHandle<T> implements Handle<T>, RegisteredHandle {
  readonly key: string

  private readonly store: HandleStore
  private readonly loader: Loader<T>
  private readonly equality: (a: T, b: T) => boolean

  private value: T | undefined = undefined
  private status_: HandleStatus = 'idle'
  private error: unknown = undefined

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
  }

  // ──── Handle<T> surface ────

  peek(): T | undefined { return this.value }

  status(): HandleStatus { return this.status_ }

  load(): Promise<T> {
    if (this.disposed) {
      return Promise.reject(new Error(`Handle ${this.key} has been disposed`))
    }
    if (this.status_ === 'ready' && this.value !== undefined) {
      return Promise.resolve(this.value)
    }
    if (this.inflight) return this.inflight
    return this.runLoader()
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
  private runLoader(): Promise<T> {
    // Reset pending-reinvalidate at run start. Anything that arrives
    // during this run sets the flag; we re-run after settle. Same for
    // the queue of changes recorded against post-load deps.
    this.store.metrics.loaderRuns++
    this.pendingReinvalidate = false
    this.changesDuringLoad = []
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
    const onDep = (dep: Dependency) => {
      collected.push(dep)
      this.deps.push(dep) // live-publish so mid-load matches() sees it
    }
    const ctx: ResolveContext = {
      depend(dep: Dependency) { onDep(dep) },
    }

    const p = this.loader(ctx).then(
      (value) => {
        // Disposal during a load: don't apply, don't notify.
        if (this.disposed) throw new Error(`Handle ${this.key} disposed mid-load`)
        const priorValue = this.value
        const hadPrior = this.status_ === 'ready' || this.status_ === 'error'
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
        this.value = value
        this.status_ = 'ready'
        this.error = undefined
        this.inflight = null
        this.suspendingPromise = null
        // Structural-diff: skip listener walk if value didn't change
        // (spec §9.4). On the first successful load there's no prior
        // value to compare against — always notify.
        if (!hadPrior || priorValue === undefined || !this.equality(priorValue, value)) {
          this.notify(value)
        } else {
          // Equality match against prior value: notify suppressed.
          // Counts even when the listener set is empty — the dedup
          // decision happened, we measure the decision, not the walk.
          this.store.metrics.notifiesSkippedByDiff++
        }
        this.release() // drop the inflight ref
        // If invalidations arrived during this load, the data we just
        // returned may already be stale. Re-run via a microtask so the
        // promise that React awaited can resolve first.
        if (this.pendingReinvalidate && !this.disposed) {
          this.pendingReinvalidate = false
          this.store.metrics.reloadsAfterSettle++
          queueMicrotask(() => {
            if (this.disposed) return
            // No-op if a fresher load is already in flight (subscribe
            // path or another invalidate scheduled it).
            if (this.inflight) return
            void this.runLoader().catch(() => {/* error on handle */})
          })
        }
        return value
      },
      (err) => {
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
          // may succeed.
          if (this.pendingReinvalidate) {
            this.pendingReinvalidate = false
            this.store.metrics.reloadsAfterSettle++
            queueMicrotask(() => {
              if (this.disposed) return
              if (this.inflight) return
              void this.runLoader().catch(() => {/* error on handle */})
            })
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
    // First subscriber kicks off a load if we're idle.
    if (this.status_ === 'idle' && !this.inflight) {
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

  observeDuringLoad(change: ChangeNotification): void {
    // Only worth recording while a load is actually in flight.
    // Capacity isn't bounded by design — invalidations are infrequent
    // relative to load duration, and the queue clears on every settle.
    if (this.inflight) this.changesDuringLoad.push(change)
  }

  invalidate(): void {
    if (this.disposed) return
    this.store.metrics.loaderInvalidations++
    // Force a re-resolve. Readers see the stale value via peek() until
    // the new load completes — status stays 'ready' so the UI doesn't
    // flash a Suspense fallback for in-place updates.
    if (this.inflight) {
      // A load is already running; it may have read stale data from
      // SQL before the invalidating commit landed. Mark the run as
      // dirty so runLoader's settle path schedules another pass once
      // the current promise resolves. Multiple invalidations during
      // one load coalesce into a single rerun (the next loader picks
      // up the latest state in one go).
      this.store.metrics.midLoadInvalidations++
      this.pendingReinvalidate = true
      return
    }
    void this.runLoader().catch(() => {/* error on handle */})
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
    this.status_ = 'idle'
    this.inflight = null
    this.suspendingPromise = null
    this.store.remove(this.key)
  }

  // ──── private ────

  private notify(value: T): void {
    if (this.listeners.size === 0) return
    this.store.metrics.notifiesFired++
    // Structural-diff against the prior value cheaply: if the value
    // didn't actually change (re-resolve produced an equal result),
    // skip the listener walk.
    // We compare against the value we've already stored (above caller
    // updated `this.value` first — peek() must return the new value
    // when listeners fire).
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
    case 'backlink-target':
      return change.backlinkTargets ? has(change.backlinkTargets, dep.id) : false
  }
}

const has = (xs: ReadonlySet<string> | readonly string[], target: string): boolean => {
  if (xs instanceof Set) return xs.has(target)
  for (const x of xs) if (x === target) return true
  return false
}

/** Stable args→key serializer. JSON.stringify with sorted object keys
 *  so `{a:1,b:2}` and `{b:2,a:1}` yield the same key (spec identity rule). */
export const stableArgsKey = (args: unknown): string => {
  if (args === undefined || args === null) return ''
  return JSON.stringify(args, sortedReplacer(args))
}

const sortedReplacer = (root: unknown) => {
  // For plain objects, walk with sorted keys. Arrays + primitives untouched.
  // We keep this allocation-free for the common no-object case via the
  // root-type peek above.
  if (typeof root !== 'object' || root === null || Array.isArray(root)) {
    return undefined
  }
  return (_key: string, value: unknown) => {
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      const obj = value as Record<string, unknown>
      const out: Record<string, unknown> = {}
      for (const k of Object.keys(obj).sort()) out[k] = obj[k]
      return out
    }
    return value
  }
}

/** Compose a Handle key from a name + optional args. Used by Repo
 *  factories to construct identity-stable keys. */
export const handleKey = (name: string, args?: unknown): string =>
  args === undefined ? name : `${name}:${stableArgsKey(args)}`

/** Per-id snapshot pair shape. Mirrors `SnapshotEntry` from
 *  `txSnapshots.ts` without importing it (handleStore stays free of
 *  internals dependencies). `references` is included so the
 *  `backlinkTargets` symmetric-diff path can compute "did this row's
 *  outgoing-edge set change". */
export interface ChangeSnapshot {
  before: {
    parentId: string | null
    workspaceId: string
    deleted?: boolean
    references?: ReadonlyArray<{ id: string }>
  } | null
  after: {
    parentId: string | null
    workspaceId: string
    deleted?: boolean
    references?: ReadonlyArray<{ id: string }>
  } | null
}

/** Compute a `ChangeNotification` from a tx's per-id snapshots map.
 *  Used by the TxEngine fast path (§9.3): post-commit, the engine
 *  passes its snapshots map here and feeds the result into
 *  `handleStore.invalidate(...)`.
 *
 *  Rules:
 *    - `rowIds`: every id touched by the tx (any field change is enough
 *       to invalidate row deps).
 *    - `parentIds`: union of `before.parentId` / `after.parentId` ONLY
 *       when the row's *membership* in a parent's live-children set
 *       changed (creation, soft-deletion, restore, parent move). Pure
 *       content / property edits don't fire parent-edge deps.
 *    - `workspaceIds`: every workspace_id touched (covers backlinks
 *       handles' coarse workspace dep).
 *    - `tables`: `['blocks']` whenever there's at least one snapshot
 *       (every snapshot here represents a `blocks` write — the engine
 *       only writes to that table). Required for query handles that
 *       declare `ctx.depend({kind:'table', table:'blocks'})` (the
 *       coarse fallback for table-scan resolvers, especially ones with
 *       empty results that have no per-row deps to invalidate against).
 *    - `backlinkTargets`: target ids whose incoming-edge set changed.
 *       Computed as symmetric difference of `before.references` and
 *       `after.references` (treating soft-deletes/restores as "all
 *       edges" lost/gained). A row whose `references_json` is unchanged
 *       (or whose changes don't alter the set of distinct target ids)
 *       contributes nothing here — content-only edits, focus-state
 *       writes, and property edits don't invalidate backlinks handles.
 */
export const snapshotsToChangeNotification = (
  snapshots: ReadonlyMap<string, ChangeSnapshot>,
): ChangeNotification => {
  const rowIds = new Set<string>()
  const parentIds = new Set<string>()
  const workspaceIds = new Set<string>()
  const backlinkTargets = new Set<string>()
  const tables = snapshots.size > 0 ? new Set<string>(['blocks']) : undefined
  for (const [id, entry] of snapshots) {
    rowIds.add(id)
    if (entry.before?.workspaceId) workspaceIds.add(entry.before.workspaceId)
    if (entry.after?.workspaceId) workspaceIds.add(entry.after.workspaceId)

    const beforeParent = entry.before?.parentId ?? null
    const afterParent = entry.after?.parentId ?? null
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
    // Pure field change with same parent_id and same liveness: rowId
    // alone covers it. No parent-edge entry — `repo.children(id)`
    // already declares row deps on each child for this case.

    // Backlink-target diff: a soft-deleted (or never-live) row
    // contributes no outgoing edges per the `block_references` trigger
    // gate (`WHERE NEW.deleted = 0`); treat its effective ref set as
    // empty for diff purposes. The symmetric difference is the set of
    // targets whose incoming-edge list either gained or lost this row.
    const beforeRefs = beforeLive ? entry.before?.references ?? [] : []
    const afterRefs = afterLive ? entry.after?.references ?? [] : []
    addSymmetricTargetDiff(beforeRefs, afterRefs, backlinkTargets)
  }
  return { rowIds, parentIds, workspaceIds, tables, backlinkTargets }
}

/** Add to `out` every target id present in exactly one of `before` /
 *  `after`. Reorderings or alias-only changes that preserve the set of
 *  distinct target ids contribute nothing. */
const addSymmetricTargetDiff = (
  before: ReadonlyArray<{ id: string }>,
  after: ReadonlyArray<{ id: string }>,
  out: Set<string>,
): void => {
  if (before.length === 0 && after.length === 0) return
  const beforeIds = new Set<string>()
  for (const r of before) beforeIds.add(r.id)
  const afterIds = new Set<string>()
  for (const r of after) afterIds.add(r.id)
  for (const id of beforeIds) if (!afterIds.has(id)) out.add(id)
  for (const id of afterIds) if (!beforeIds.has(id)) out.add(id)
}
