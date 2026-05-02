/**
 * New `Repo` class for the data-layer redesign (spec §3, §8).
 *
 * Stage 1.4 scope: holds `db` + `cache` + `user` + the mutator registry
 * (kernel mutators registered at construction time). Exposes:
 *   - `repo.tx(fn, opts)` — primitive transactional session
 *   - `repo.mutate.X(args)` — typed-dispatch sugar (1-mutator tx wrapping)
 *   - `repo.run(name, args)` — runtime-validated dispatch (dynamic plugins)
 *   - `repo.setFacetRuntime(runtime)` — refresh mutator registry from a
 *     FacetRuntime. Minimal impl reads `mutatorsFacet` contributions.
 *
 * Stage 2 of Phase 1 (post-1.6) adds:
 *   - HandleStore + `repo.block(id)` / `repo.children(id)` / etc.
 *   - row_events tail subscription for sync-applied invalidation
 */

import { v4 as uuidv4 } from 'uuid'
import type { FacetRuntime } from '@/extensions/facet'
import type {
  AnyMutator,
  AnyPostCommitProcessor,
  AnyQuery,
  BlockData,
  Mutator,
  MutatorRegistry,
  Query,
  QueryRegistry,
  RepoTxOptions,
  Tx,
  User,
} from '@/data/api'
import {
  ChangeScope,
  MutatorNotRegisteredError,
  QueryNotRegisteredError,
} from '@/data/api'
import { runTx, type PowerSyncDb } from './commitPipeline'
import type { BlockCache } from '@/data/blockCache'
import { parseBlockRow, type BlockRow } from '@/data/blockSchema'
import { KERNEL_MUTATORS } from './kernelMutators'
import { KERNEL_PROCESSORS } from './parseReferencesProcessor'
import { KERNEL_QUERIES } from './kernelQueries'
import { mutatorsFacet, postCommitProcessorsFacet, queriesFacet } from './facets'
import { ProcessorRunner } from './processorRunner'
import { Block } from './block'
import {
  HandleStore,
  LoaderHandle,
  handleKey,
  snapshotsToChangeNotification,
  type ResolveContext,
} from './handleStore'
import {
  startRowEventsTail,
  type RowEventsTail,
  type RowEventsTailOptions,
} from './rowEventsTail'
import { UndoManager, type UndoEntry } from './undoManager'
import type { TxImpl } from './txEngine'
import { ANCESTORS_SQL, CHILDREN_SQL, SUBTREE_SQL } from './treeQueries'
import { SELECT_BLOCK_BY_ID_SQL } from './kernelQueries'

/** Convert a `Mutator<Args, Result>` into the `repo.mutate` dispatcher
 *  signature `(args: Args) => Promise<Result>`. Used to project
 *  augmented `MutatorRegistry` entries into precise per-key types on
 *  the proxy field. */
type DispatchFor<M> = M extends Mutator<infer A, infer R>
  ? (args: A) => Promise<R>
  : never

/** Per-key dispatcher types for every mutator known at compile time —
 *  every `MutatorRegistry` member, plus the bare `core.<name>`-stripped
 *  shortcut. Plugins extend this surface by augmenting the
 *  `MutatorRegistry` interface from `@/data/api`; kernel mutators are
 *  augmented in `kernelMutators.ts`. */
type KnownMutateDispatch = {
  [K in keyof MutatorRegistry]: DispatchFor<MutatorRegistry[K]>
} & {
  [K in keyof MutatorRegistry as K extends `core.${infer Bare}`
    ? Bare
    : never]: DispatchFor<MutatorRegistry[K]>
}

/** Proxy contract surface. Known keys (above) get precise typing;
 *  unknown keys fall through the `any` index signature so dynamically
 *  loaded plugins that haven't augmented `MutatorRegistry` are still
 *  callable via `repo.mutate['plugin:foo'](args)`. The runtime
 *  argsSchema validation in `dispatchMutator` stays the source of truth
 *  for safety on those paths. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type MutateProxy = KnownMutateDispatch & { [name: string]: (args: any) => Promise<any> }

/** Convert a `Query<Args, Result>` into the `repo.query` dispatcher
 *  signature `(args: Args) => LoaderHandle<Result>`. Mirrors
 *  `DispatchFor` for mutators. Returning the concrete `LoaderHandle<R>`
 *  (not just `Handle<R>`) keeps consistency with the existing
 *  `repo.subtree(id)` / `repo.children(id)` factories. */
type DispatchQueryFor<Q> = Q extends Query<infer A, infer R>
  ? (args: A) => LoaderHandle<R>
  : never

type KnownQueryDispatch = {
  [K in keyof QueryRegistry]: DispatchQueryFor<QueryRegistry[K]>
} & {
  [K in keyof QueryRegistry as K extends `core.${infer Bare}`
    ? Bare
    : never]: DispatchQueryFor<QueryRegistry[K]>
}

/** Proxy contract surface for `repo.query`. Mirrors `MutateProxy`:
 *  known keys (kernel + augmented plugins per `QueryRegistry`) get
 *  precise typing; unknown string keys fall through the `any` index
 *  so dynamically-loaded plugins are still callable via
 *  `repo.query['plugin:foo'](args)`. The argsSchema validation in
 *  `dispatchQuery` is the runtime safety boundary for those paths. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type QueryProxy = KnownQueryDispatch & { [name: string]: (args: any) => LoaderHandle<any> }

export interface RepoOptions {
  db: PowerSyncDb
  cache: BlockCache
  user: User
  /** Read-only mode disables `BlockDefault` / `References` writes. UI-state
   *  scope (`local-ui`) is still allowed. Default false. */
  isReadOnly?: boolean
  /** Now provider — default `Date.now`. Injected for test determinism. */
  now?: () => number
  /** UUID provider — default `crypto.randomUUID`. Injected for tests
   *  that want deterministic ids. */
  newId?: () => string
  /** Monotonic INTEGER tx-grouping key provider, written into
   *  `tx_context.tx_seq` and copied to `ps_crud.tx_id` by the upload
   *  triggers. Default: a counter seeded from `Date.now()` so values
   *  never collide with anything from a prior run. Tests can inject a
   *  deterministic counter. */
  newTxSeq?: () => number
  /** When true (default), kernel mutators are registered at
   *  construction time so `repo.mutate.indent({...})` works
   *  immediately. Set false when a test wants to populate the registry
   *  explicitly (or when `setFacetRuntime` is the only registration
   *  path). */
  registerKernelMutators?: boolean
  /** When true (default), kernel post-commit processors are registered
   *  at construction time. Set false when a test isolates the engine /
   *  mutator surface from processor side-effects (e.g. parseReferences
   *  firing on every content write would add follow-up txs the engine
   *  test isn't asserting on). */
  registerKernelProcessors?: boolean
  /** When true (default), kernel queries are registered at construction
   *  time so `repo.query.subtree({id})` etc. work immediately without a
   *  `setFacetRuntime` call. Set false when a test wants to populate
   *  the query registry explicitly. Mirrors `registerKernelMutators` /
   *  `registerKernelProcessors`. */
  registerKernelQueries?: boolean
  /** When true (default), the row_events tail subscription is started
   *  at construction time so sync-applied writes propagate into the
   *  cache + invalidate handles (spec §9.3). Set false in unit tests
   *  that want explicit control over tail timing — they can call
   *  `repo.startRowEventsTail({initialLastId: 0})` to opt back in
   *  with deterministic semantics. */
  startRowEventsTail?: boolean
  /** Options forwarded to the row_events tail when started. */
  rowEventsTailOptions?: RowEventsTailOptions
}

export class Repo {
  readonly db: PowerSyncDb
  readonly cache: BlockCache
  user: User
  /** Read-only mode disables `BlockDefault` / `References` writes;
   *  UI-state writes still pass through (they route to local-ephemeral
   *  source unconditionally per spec §5.8 / §10). Mutate via
   *  `repo.setReadOnly(value)` rather than direct field assignment so
   *  callers from inside React hooks don't trip
   *  `react-hooks/immutability` lint (the mutation should travel
   *  through a method, not a property write). */
  isReadOnly: boolean

  private readonly now: () => number
  private readonly newId: () => string
  private readonly newTxSeq: () => number
  private mutators: Map<string, AnyMutator> = new Map()
  private processors: Map<string, AnyPostCommitProcessor> = new Map()
  private queries: Map<string, AnyQuery> = new Map()
  /** Per-query-name generation counter. Bumped by `setFacetRuntime`
   *  (and `__setQueriesForTesting`) whenever a name's registered Query
   *  instance changes — including when a name is added or removed. The
   *  generation is folded into the query handle-store key so cached
   *  handles that closed over the OLD resolver no longer collide with
   *  fresh lookups, which produce a new LoaderHandle bound to the NEW
   *  resolver. Old handles GC after their subscribers detach (the
   *  HandleStore's normal ref-count path). Reviewer P2: prevents
   *  same-name plugin updates from continuing to dispatch through the
   *  pre-swap resolver / argsSchema. */
  private queryGenerations: Map<string, number> = new Map()
  private readonly processorRunner: ProcessorRunner
  /** Per-scope undo / redo stacks (spec §10 step 7, §17 line 2228).
   *  `repo.tx` records every undoable commit here; `repo.undo` /
   *  `repo.redo` pop entries and replay them via `TxImpl.applyRaw`. */
  readonly undoManager: UndoManager
  /** Identity-stable Block facades, keyed by id. Block satisfies
   *  Handle<BlockData|null> structurally (spec §5.1, §5.2) — its
   *  row-grain reactivity goes through BlockCache.subscribe directly,
   *  so it doesn't need a HandleStore entry; this map IS its identity
   *  table. */
  private readonly blockFacades = new Map<string, Block>()
  /** Handle registry for collection factories: `repo.children`,
   *  `repo.subtree`, `repo.ancestors`, `repo.backlinks`. Identity rule:
   *  same key → same LoaderHandle instance. GC after `gcTimeMs` of
   *  zero subscribers + zero in-flight loads. The store also walks
   *  invalidation: TxEngine fast path + row_events tail (Phase 2.C)
   *  call `handleStore.invalidate({…})` to fan out to dep-matching
   *  handles. */
  readonly handleStore: HandleStore = new HandleStore()
  /** Active row_events tail (spec §9.3 path 2). Lazy: created on first
   *  start, replaced on subsequent starts. Tests can `dispose()` and
   *  re-`start` for deterministic flushing. */
  private rowEventsTail: RowEventsTail | null = null
  /** Backing field for `activeWorkspaceId` (see getter/setter below). */
  private _activeWorkspaceId: string | null = null
  /** Instance discriminator for memoization keys that need to vary
   *  across Repo instances (e.g. lodash.memoize calls in the panel /
   *  user-page bootstrap). Auto-incremented per construction. */
  private static nextInstanceId = 1
  readonly instanceId: number = Repo.nextInstanceId++

  /** Hydrate a list of `BlockRow`s into the cache + return parsed
   *  BlockData[]. Internal helper for the kernel queries. When `ctx`
   *  is supplied, also declares a per-row dep so handle invalidations
   *  fire on row updates. Accepts readonly so it pairs cleanly with
   *  the `QueryCtx.hydrateBlocks` plumbing in `dispatchQuery`. */
  private hydrateRows(rows: ReadonlyArray<BlockRow>, ctx?: ResolveContext): BlockData[] {
    const out: BlockData[] = []
    for (const r of rows) {
      const data = parseBlockRow(r)
      this.cache.applySyncSnapshot(data)
      if (ctx) ctx.depend({kind: 'row', id: data.id})
      out.push(data)
    }
    return out
  }

  /** Run `CHILDREN_SQL` for `parentId` and hydrate every row into the
   *  per-row cache. Shared by the `repo.load(id, {children: true})`
   *  opts path, `repo.children(id)` handle, and the hydrating variant
   *  of `repo.childIds(id)`. Collection-level reactivity is owned by
   *  the `LoaderHandle` returned from `repo.children` / `repo.childIds`
   *  — `BlockCache` doesn't track per-parent "loaded" state. */
  private async hydrateChildren(parentId: string, ctx?: ResolveContext): Promise<BlockData[]> {
    const rows = await this.db.getAll<BlockRow>(CHILDREN_SQL, [parentId])
    return this.hydrateRows(rows, ctx)
  }

  /** Typed-dispatch sugar. `repo.mutate.indent({id})` opens a 1-mutator
   *  tx with the mutator's scope and runs it. Lookup tries the literal
   *  key first (`'tasks:setDueDate'` for plugin mutators), then
   *  `'core.${name}'` (so the bare `repo.mutate.indent` resolves to
   *  `'core.indent'`).
   *
   *  Typing surface (Phase 3 — chunk C): keys present in
   *  `MutatorRegistry` (kernel + augmented plugins, see §12.1) get
   *  precise `(args: Args) => Promise<Result>` types; the
   *  `core.<name>`-stripped form is also typed. Unknown keys
   *  (dynamically-loaded plugins that haven't augmented the registry)
   *  fall back to a permissive `(args: any) => Promise<any>` index
   *  signature so string-key access stays callable. */
  readonly mutate: MutateProxy

  /** Typed query dispatch. `repo.query.subtree({id})` returns an
   *  identity-stable `LoaderHandle<R>` (the same instance for the same
   *  args, GC'd via HandleStore). Lookup tries the literal `name` first
   *  (`'core.subtree'` or `'plugin:foo'`), then `'core.${name}'` so the
   *  bare `repo.query.subtree` resolves to `'core.subtree'`. Args are
   *  validated against `Query.argsSchema` on every call.
   *
   *  Typing surface mirrors `repo.mutate`: keys present in
   *  `QueryRegistry` (kernel + augmented plugins) get precise
   *  `(args: Args) => LoaderHandle<Result>` types; the
   *  `core.<name>`-stripped form is also typed. Unknown keys
   *  (dynamically-loaded plugins that haven't augmented the registry)
   *  fall back to a permissive `(args: any) => LoaderHandle<any>` index
   *  signature so string-key access stays callable. The runtime
   *  `argsSchema` validation in `dispatchQuery` is the safety boundary
   *  for those paths. */
  readonly query: QueryProxy

  constructor(opts: RepoOptions) {
    this.db = opts.db
    this.cache = opts.cache
    this.user = opts.user
    this.isReadOnly = opts.isReadOnly ?? false
    this.now = opts.now ?? Date.now
    this.newId = opts.newId ?? uuidv4
    // Default tx-seq provider: monotonic counter seeded above any
    // value a prior Repo instance could have written. Date.now() in
    // milliseconds is plenty of headroom (Number.MAX_SAFE_INTEGER /
    // ms-per-day ~= a few hundred thousand years).
    if (opts.newTxSeq) {
      this.newTxSeq = opts.newTxSeq
    } else {
      let seq = Date.now()
      this.newTxSeq = () => ++seq
    }
    // Register kernel contributions by default. setFacetRuntime
    // overrides with the merged kernel + plugin registry once a
    // runtime is supplied; callers can pass either of the
    // `registerKernel*` flags as `false` to start empty for that
    // facet (used by tests + tooling that want explicit registration
    // semantics). The two flags are independent so engine tests can
    // skip processor side-effects while keeping mutator dispatch.
    if (opts.registerKernelMutators ?? true) {
      this.registerMutators(KERNEL_MUTATORS)
    }
    if (opts.registerKernelProcessors ?? true) {
      for (const p of KERNEL_PROCESSORS) this.processors.set(p.name, p)
    }
    if (opts.registerKernelQueries ?? true) {
      for (const q of KERNEL_QUERIES) this.queries.set(q.name, q)
    }
    // Initialize the processor runner. The runner needs a Repo
    // reference for opening processor txs; passing `this` is safe
    // because runner methods only use it post-construction (during
    // dispatch). The runner reads its registry per-tx from the snapshot
    // baked into TxResult — we don't sync a registry into the runner
    // here.
    this.processorRunner = new ProcessorRunner(this, opts.db)
    this.undoManager = new UndoManager()
    // Bind dispatchMutator to `this` so the Proxy's get trap doesn't
    // need to alias `this` to a local. Each name lookup returns a
    // fresh dispatcher closure; that's fine, the underlying registry
    // lookup is a single Map.get.
    const dispatch = this.dispatchMutator.bind(this)
    this.mutate = new Proxy({} as Record<string, (args: unknown) => Promise<unknown>>, {
      get: (_target, prop) => {
        if (typeof prop !== 'string') return undefined
        return dispatch(prop)
      },
    }) as MutateProxy
    // Same Proxy shape as `mutate`, dispatching to `dispatchQuery`.
    // Each name access returns a fresh dispatcher closure; the closure
    // does the registry lookup + argsSchema validation + handleStore
    // getOrCreate on call. Identity stability is provided by the
    // handle-store key, not by memoizing the dispatcher itself.
    const dispatchQ = this.dispatchQuery.bind(this)
    this.query = new Proxy({} as Record<string, (args: unknown) => LoaderHandle<unknown>>, {
      get: (_target, prop) => {
        if (typeof prop !== 'string') return undefined
        return dispatchQ(prop)
      },
    }) as QueryProxy
    // Start the row_events tail by default (spec §9.3). Tests that
    // want deterministic timing pass startRowEventsTail: false and
    // call repo.startRowEventsTail({initialLastId: 0}) themselves
    // before issuing sync-style writes.
    if (opts.startRowEventsTail ?? true) {
      this.startRowEventsTail(opts.rowEventsTailOptions)
    }
  }

  /** Start the row_events tail subscription (spec §9.3). Idempotent
   *  in spirit: if a tail is already running, it's disposed first so
   *  the new options take effect. Returns the tail for inspection /
   *  manual flushing. */
  startRowEventsTail(options?: RowEventsTailOptions): RowEventsTail {
    if (this.rowEventsTail) this.rowEventsTail.dispose()
    this.rowEventsTail = startRowEventsTail({
      db: this.db,
      cache: this.cache,
      handleStore: this.handleStore,
      options,
    })
    return this.rowEventsTail
  }

  /** Dispose the active row_events tail (no-op if none). Tests use
   *  this to detach the subscription before tearing down the test DB. */
  stopRowEventsTail(): void {
    if (this.rowEventsTail) {
      this.rowEventsTail.dispose()
      this.rowEventsTail = null
    }
  }

  /** Manually flush the row_events tail — synchronously consumes any
   *  rows not yet processed and walks `handleStore.invalidate(...)`.
   *  Tests use this instead of waiting on the throttle window. */
  async flushRowEventsTail(): Promise<void> {
    if (this.rowEventsTail) await this.rowEventsTail.flush()
  }

  /** Frozen snapshot of internal data-layer counters (perf-baseline
   *  follow-up #4). Returns plain-number aggregates from:
   *
   *    - `handleStore` — invalidate fan-out (`invalidations`,
   *      `handlesWalked`, `handlesMatched`) and per-LoaderHandle
   *      lifecycle (`loaderInvalidations`, `loaderRuns`,
   *      `midLoadInvalidations`, `reloadsAfterSettle`,
   *      `notifiesFired`, `notifiesSkippedByDiff`).
   *    - `blockCache` — write/notify activity
   *      (`setSnapshotCalls`, `setSnapshotDedupHits/Misses`,
   *      `applySyncSnapshotCalls`, `applySyncSnapshotRejected`,
   *      `notifies`).
   *
   *  All counters are monotonic from the last `resetMetrics()` (or
   *  Repo construction). Each call returns a fresh frozen object so
   *  callers can keep two snapshots and diff them.
   *
   *  Useful as:
   *    - regression detection in production (`handlesWalked /
   *      invalidations` should drop to ~`handlesMatched / invalidations`
   *      once the inverted-index optimisation lands),
   *    - integration-test assertions (mutate.setContent wrote N times,
   *      did dedup hit?), and
   *    - in-app debug panels that surface "this page has X handles
   *      registered, Y invalidations, Z loader runs since open." */
  metrics(): Readonly<{
    handleStore: Readonly<Record<string, number>>
    blockCache: Readonly<Record<string, number>>
  }> {
    return Object.freeze({
      handleStore: this.handleStore.metrics.snapshot(),
      blockCache: this.cache.metrics.snapshot(),
    })
  }

  /** Zero every counter in `repo.metrics()`. Use to mark a baseline
   *  before measuring a discrete operation (e.g. a benchmark iteration
   *  or a UI interaction in a soak test). */
  resetMetrics(): void {
    this.handleStore.metrics.reset()
    this.cache.metrics.reset()
  }

  /** Get a `Block` facade for `id`. Sync — does NOT load. Read access
   *  on the returned facade (`block.data`, `block.peek()`, etc.) is gated
   *  by what's in cache; call `block.load()` or `repo.load(id)` first
   *  for guaranteed availability. The same `Block` instance is returned
   *  on repeat calls so identity-based React keys / memo work. */
  block(id: string): Block {
    let cached = this.blockFacades.get(id)
    if (!cached) {
      cached = new Block(this, id)
      this.blockFacades.set(id, cached)
    }
    return cached
  }

  /** Load a row + (optionally) a neighborhood into the cache. Spec §5.2.
   *
   *    repo.load(id)                          → just the row
   *    repo.load(id, {children: true})        → row + immediate children
   *    repo.load(id, {ancestors: true})       → row + full parent chain
   *    repo.load(id, {descendants: N})        → row + subtree clipped at
   *                                              depth N (or whole tree
   *                                              if N is omitted/falsy
   *                                              for descendants:true)
   *
   *  Hydrates rows into the cache so subsequent `block.peek()` /
   *  `block.data` calls succeed. Collection reactivity (children /
   *  subtree handles) is owned by the HandleStore, not this loader —
   *  use `repo.query.children({id}).load()` if you want a
   *  handle-cached child-rows list with structural invalidation.
   *
   *  Concurrency note: this method does NOT use `BlockCache.dedupLoad`.
   *  That helper keys by id only, which silently merged a plain
   *  `repo.load(id)` with a concurrent `repo.load(id, {children: true})`
   *  — the second caller would see the plain promise resolve and miss
   *  the children. Inlining the load costs at most one extra row read
   *  per concurrent caller; the cache's `setSnapshot` is
   *  fingerprint-deduplicated so listeners don't fire twice. */
  async load(
    id: string,
    opts?: { children?: boolean; ancestors?: boolean; descendants?: boolean | number },
  ): Promise<BlockData | null> {
    const row = await this.db.getOptional<BlockRow>(
      'SELECT * FROM blocks WHERE id = ? AND deleted = 0', [id],
    )
    if (row === null) {
      this.cache.markMissing(id)
      return null
    }
    const data = parseBlockRow(row)
    this.cache.applySyncSnapshot(data)

    if (opts?.children) await this.hydrateChildren(id)

    if (opts?.ancestors) {
      // Pass id twice — ANCESTORS_SQL uses it as both start and skip.
      const ancestorRows = await this.db.getAll<BlockRow>(ANCESTORS_SQL, [id, id])
      for (const r of ancestorRows) this.cache.applySyncSnapshot(parseBlockRow(r))
    }

    if (opts?.descendants) {
      const subtreeRows = await this.db.getAll<BlockRow & {depth: number}>(SUBTREE_SQL, [id])
      const maxDepth = typeof opts.descendants === 'number' ? opts.descendants : Infinity
      for (const r of subtreeRows) {
        if (r.depth > maxDepth) continue
        this.cache.applySyncSnapshot(parseBlockRow(r))
      }
    }

    return data
  }

  /** Async existence check — cache-first, falls back to a single SQL
   *  hit. Soft-deleted rows count as MISSING here so create/restore
   *  flows on the caller side get the consistent "not found" signal.
   *  The cache holds tombstone snapshots after `tx.delete` (so peek
   *  can show `deleted: true`); `hasSnapshot` alone would falsely
   *  report a tombstoned row as existing, hence the `deleted` gate. */
  async exists(id: string): Promise<boolean> {
    const cached = this.cache.getSnapshot(id)
    if (cached !== undefined) return !cached.deleted
    const row = await this.db.getOptional<{id: string}>(SELECT_BLOCK_BY_ID_SQL, [id])
    return row !== null
  }

  // ──── Active-workspace getter/setter (UI bookkeeping) ────

  /** UI-visible "active" workspace pin — used by hooks (`useBacklinks`)
   *  and panels that need a default workspace when there's no other
   *  context. `repo.tx` does NOT consult this; tx workspaces come from
   *  the first write's row per spec §5.3. */
  get activeWorkspaceId(): string | null {
    return this._activeWorkspaceId
  }

  setActiveWorkspaceId(workspaceId: string | null): void {
    this._activeWorkspaceId = workspaceId
  }

  /** Toggle read-only mode. Wrapping the field write in a method
   *  keeps call sites that come from inside React hooks lint-clean
   *  (`react-hooks/immutability` flags direct property writes on
   *  hook outputs). UI-state writes still pass through regardless of
   *  this flag — only `BlockDefault` / `References` scopes are
   *  blocked (per spec §10.3). */
  setReadOnly(value: boolean): void {
    this.isReadOnly = value
  }

  /** Run a transactional session. Spec §3, §10. */
  async tx<R>(
    fn: (tx: Tx) => Promise<R>,
    opts: RepoTxOptions,
  ): Promise<R> {
    const result = await this._runAndDispatch(fn, opts)
    // Step 7 of the §10 pipeline — record undo entry. UiState scope
    // and zero-write txs are filtered inside `record`. Replays go
    // through `_replay`, not here, so they don't add new history.
    this.undoManager.record({
      scope: opts.scope,
      txId: result.txId,
      snapshots: result.snapshots,
      description: opts.description,
    })
    return result.value
  }

  /** Undo the most recent committed `repo.tx` for `scope`. Default
   *  scope is `BlockDefault` (the cmd-Z target). Resolves to true if
   *  an entry was popped + replayed, false if the stack was empty.
   *  Replay opens its own `repo.tx` with `source = 'user'` so the
   *  inverse syncs upstream just like the original write did (per the
   *  spec's §7.3 + the follow-ups doc's "undo of a content edit
   *  should sync the un-edit"). Throws `ReadOnlyError` in read-only
   *  mode for non-UiState scopes — matches normal `repo.tx` gating. */
  async undo(scope: ChangeScope = ChangeScope.BlockDefault): Promise<boolean> {
    const entry = this.undoManager.popUndo(scope)
    if (entry === null) return false
    try {
      await this._replay(entry, 'before')
      this.undoManager.pushRedo(scope, entry)
      return true
    } catch (err) {
      // Replay failed — push the entry back so the user can retry
      // (e.g. after toggling read-only off, fixing a missing parent).
      this.undoManager.pushUndo(scope, entry)
      throw err
    }
  }

  /** Redo the most recently undone tx for `scope`. Same default + same
   *  semantics as `undo`, mirrored. */
  async redo(scope: ChangeScope = ChangeScope.BlockDefault): Promise<boolean> {
    const entry = this.undoManager.popRedo(scope)
    if (entry === null) return false
    try {
      await this._replay(entry, 'after')
      this.undoManager.pushUndo(scope, entry)
      return true
    } catch (err) {
      this.undoManager.pushRedo(scope, entry)
      throw err
    }
  }

  /** Shared `runTx` + processor-dispatch path. Used by both `tx`
   *  (records on undo stack) and `_replay` (does not). */
  private async _runAndDispatch<R>(
    fn: (tx: Tx) => Promise<R>,
    opts: RepoTxOptions,
  ) {
    const result = await runTx({
      db: this.db,
      cache: this.cache,
      fn,
      opts,
      user: this.user,
      isReadOnly: this.isReadOnly,
      newTxId: this.newId,
      newTxSeq: this.newTxSeq,
      newId: this.newId,
      now: this.now,
      mutators: this.mutators,
      processors: this.processors,
    })
    // TxEngine fast path (spec §9.3 path 1): post-commit, fan-out the
    // tx's snapshots diff to dep-matching collection handles. The
    // commit pipeline already updated the BlockCache (which fires
    // Block.subscribe row-grain listeners) — this layer is just for
    // children/subtree/ancestors/backlinks handles. Synchronous walk;
    // each handle's runLoader is async, but `invalidate` only sets
    // pendingReinvalidate / kicks off a microtask, so the caller's tx
    // resolve isn't blocked on handle re-resolution.
    if (result.snapshots.size > 0) {
      this.handleStore.invalidate(snapshotsToChangeNotification(result.snapshots))
    }
    // Step 9 of the §10 pipeline — dispatch field-watch + explicit
    // post-commit processors. Failures are caught + logged inside the
    // runner so a buggy processor can't poison the caller's resolve.
    // Awaited so synchronously-fired processors land before the
    // caller sees the resolved promise; delayed (delayMs > 0) jobs
    // run after.
    void this.processorRunner.dispatch({
      txId: result.txId,
      user: result.user,
      workspaceId: result.workspaceId,
      snapshots: result.snapshots,
      afterCommitJobs: result.afterCommitJobs,
      processors: result.processors,
    })
    return result
  }

  /** Replay an undo / redo entry. Opens a tx in the entry's scope and
   *  raw-applies each (id → snap.before) (undo) or (id → snap.after)
   *  (redo) via the engine-internal `applyRaw` primitive. Replays do
   *  NOT push themselves onto the undo stack — the caller manages
   *  stack motion (manager.pushRedo / manager.pushUndo) so the same
   *  entry shuttles symmetrically between stacks. */
  private async _replay(
    entry: UndoEntry,
    direction: 'before' | 'after',
  ): Promise<void> {
    const action = direction === 'before' ? 'undo' : 'redo'
    const description = entry.description
      ? `${action}: ${entry.description}`
      : action
    await this._runAndDispatch(async (tx) => {
      const txImpl = tx as TxImpl
      for (const [id, snap] of entry.snapshots) {
        await txImpl.applyRaw(id, snap[direction])
      }
    }, {scope: entry.scope, description})
  }

  /** Dynamic dispatch — used by runtime-loaded plugins where the
   *  TypeScript identity isn't available. `name` is the full mutator
   *  name (e.g. `'tasks:setDueDate'` or `'core.indent'`). Args are
   *  validated at the boundary via the mutator's argsSchema. */
  async run<R = unknown>(name: string, args: unknown): Promise<R> {
    return this.dispatchMutator(name)(args) as Promise<R>
  }

  /** Dynamic query dispatch — `repo.query[name]` for runtime-loaded
   *  plugins. Resolves the query, runs `.load()`, and returns the
   *  result. The same `core.${name}` shortcut as the proxy applies. */
  async runQuery<R = unknown>(name: string, args: unknown): Promise<R> {
    return this.dispatchQuery(name)(args).load() as Promise<R>
  }

  /** Update the data-layer registries from a FacetRuntime. Spec §8.
   *  Reads `mutatorsFacet` and `postCommitProcessorsFacet` contributions
   *  (other data-layer facets land in later stages). Replaces the
   *  current registries; kernel mutators must be present in the
   *  runtime if the caller wants them — pass them in via the
   *  static-facet bundle the kernel ships. */
  setFacetRuntime(runtime: FacetRuntime): void {
    this.mutators = new Map(runtime.read(mutatorsFacet))
    this.processors = new Map(runtime.read(postCommitProcessorsFacet))
    const newQueries = new Map(runtime.read(queriesFacet))
    this.swapQueries(newQueries)
  }

  /** Replace the query registry, bumping the per-name generation
   *  counter for every name whose registered Query instance changed
   *  (including newly-added and removed names). This invalidates the
   *  handle-store keys for those queries so subsequent dispatch
   *  produces fresh `LoaderHandle`s bound to the new resolvers. */
  private swapQueries(newQueries: Map<string, AnyQuery>): void {
    for (const [name, newQ] of newQueries) {
      if (this.queries.get(name) !== newQ) {
        this.queryGenerations.set(name, (this.queryGenerations.get(name) ?? 0) + 1)
      }
    }
    for (const oldName of this.queries.keys()) {
      if (!newQueries.has(oldName)) {
        this.queryGenerations.set(oldName, (this.queryGenerations.get(oldName) ?? 0) + 1)
      }
    }
    this.queries = newQueries
  }

  /** Wait until the post-commit processor framework has nothing
   *  pending — useful in tests + scripted scenarios that need
   *  deterministic ordering after a `repo.tx` resolves. Does NOT
   *  advance timers; jobs scheduled with `delayMs` only enter the
   *  pending set when the timer fires. */
  async awaitProcessors(): Promise<void> {
    await this.processorRunner.awaitIdle()
  }

  /** Test-only escape hatch retained for stage-level tests that wire
   *  specific processor sets without a FacetRuntime. */
  __setProcessorsForTesting(processors: ReadonlyArray<AnyPostCommitProcessor>): void {
    this.processors = new Map(processors.map(p => [p.name, p]))
  }

  /** Build the dispatcher closure for a mutator name. Resolution order:
   *    1. literal `name` (kernel full-name like `'core.indent'`,
   *       plugin full-name like `'tasks:setDueDate'`)
   *    2. `'core.${name}'` (so `repo.mutate.indent` resolves to
   *       `'core.indent'` even though the registry key is full-prefixed)
   *  Throws `MutatorNotRegisteredError` if neither matches. */
  private dispatchMutator(name: string): (args: unknown) => Promise<unknown> {
    return async (args: unknown) => {
      const m = this.mutators.get(name) ?? this.mutators.get(`core.${name}`)
      if (!m) throw new MutatorNotRegisteredError(name)
      const validated = m.argsSchema.parse(args) as never
      const scope = typeof m.scope === 'function' ? m.scope(validated) : m.scope
      return this.tx(tx => tx.run(m, validated) as Promise<unknown>, {
        scope,
        description: m.describe?.(validated),
      })
    }
  }

  /** Internal: register an array of mutators into the registry by name.
   *  Used by the constructor's `registerKernel: true` path. */
  private registerMutators(mutators: ReadonlyArray<AnyMutator>): void {
    for (const m of mutators) this.mutators.set(m.name, m)
  }

  /** Test-only escape hatch retained for stage 1.3 carryover tests
   *  that wired specific mutator sets without a FacetRuntime. New
   *  tests should prefer `setFacetRuntime` or the
   *  `registerKernel: false` constructor flag plus `setFacetRuntime`. */
  __setMutatorsForTesting(mutators: ReadonlyArray<AnyMutator>): void {
    this.mutators = new Map(mutators.map(m => [m.name, m]))
  }

  /** Build the dispatcher closure for a query name. Same resolution
   *  order as `dispatchMutator`: literal name first, then
   *  `'core.${name}'`. The returned closure validates args via the
   *  query's `argsSchema`, then `getOrCreate`s an identity-stable
   *  `LoaderHandle` keyed by `(queryName, args)`. The loader wraps the
   *  query's `resolve` with a `QueryCtx` that forwards `depend` to the
   *  handle's `ResolveContext` and exposes `db` / `repo` /
   *  `hydrateBlocks`. */
  private dispatchQuery(name: string): (args: unknown) => LoaderHandle<unknown> {
    return (args: unknown) => {
      const q = this.queries.get(name) ?? this.queries.get(`core.${name}`)
      if (!q) throw new QueryNotRegisteredError(name)
      const validated = q.argsSchema.parse(args) as never
      // Use the registry-stored full name in the key so the bare-name
      // shortcut (`repo.query.subtree`) and the literal full-name access
      // (`repo.query['core.subtree']`) hit the same handle slot.
      const fullName = q.name
      const gen = this.queryGenerations.get(fullName) ?? 0
      // Folding the per-name generation into the key means a swap
      // (setFacetRuntime replacing this query's instance) produces a
      // distinct handle slot — old handles GC after subscribers
      // detach; new lookups bind to the new resolver.
      const key = handleKey(`query:${fullName}@${gen}`, validated)
      return this.handleStore.getOrCreate(key, () => new LoaderHandle({
        store: this.handleStore,
        key,
        loader: async (ctx) => {
          const raw = await q.resolve(validated, {
            db: this.db,
            repo: this,
            hydrateBlocks: (rows) => this.hydrateRows(rows as unknown as ReadonlyArray<BlockRow>, ctx),
            depend: (dep) => ctx.depend(dep),
          })
          // Result-schema parse at the boundary — symmetry with argsSchema
          // and the documented contract (Query.resultSchema is required).
          // For loose kernel schemas (`z.array(z.unknown())`) this is a
          // pass-through; for strict plugin schemas it's the safety net
          // that prevents a malformed resolver from publishing to the
          // handle's subscribers + Suspense throwers.
          return q.resultSchema.parse(raw)
        },
      }))
    }
  }

  /** Test-only escape hatch parallel to `__setMutatorsForTesting`.
   *  Bypasses the FacetRuntime so unit tests can register a single
   *  query without standing up a full kernel runtime. Routes through
   *  `swapQueries` so generation bookkeeping stays consistent with
   *  the production `setFacetRuntime` path. */
  __setQueriesForTesting(queries: ReadonlyArray<AnyQuery>): void {
    this.swapQueries(new Map(queries.map(q => [q.name, q])))
  }
}

// Re-import ChangeScope so the file's TypeScript module structure
// includes a use of it (used inside dispatchMutator's scope-resolve
// path indirectly through Mutator.scope; explicit import keeps the
// dependency visible to readers).
void ChangeScope
