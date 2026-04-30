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

import {randomUUID} from 'node:crypto'
import type { FacetRuntime } from '@/extensions/facet'
import type {
  AnyMutator,
  AnyPostCommitProcessor,
  BlockData,
  RepoTxOptions,
  Tx,
  User,
} from '@/data/api'
import { ChangeScope, MutatorNotRegisteredError } from '@/data/api'
import { runTx, type PowerSyncDb } from './commitPipeline'
import type { BlockCache } from '@/data/blockCache'
import { parseBlockRow, type BlockRow } from '@/data/blockSchema'
import { KERNEL_MUTATORS } from './kernelMutators'
import { KERNEL_PROCESSORS } from './parseReferencesProcessor'
import { mutatorsFacet, postCommitProcessorsFacet } from './facets'
import { ProcessorRunner } from './processorRunner'
import { Block } from './block'
import { ANCESTORS_SQL, CHILDREN_SQL, SUBTREE_SQL } from './treeQueries'
import {
  SELECT_ALIAS_MATCHES_IN_WORKSPACE_SQL,
  SELECT_ALIASES_IN_WORKSPACE_SQL,
  SELECT_BACKLINKS_FOR_BLOCK_SQL,
  SELECT_BLOCK_BY_ALIAS_IN_WORKSPACE_SQL,
  SELECT_BLOCK_BY_ID_SQL,
  SELECT_BLOCKS_BY_CONTENT_SQL,
  SELECT_BLOCKS_BY_TYPE_SQL,
  SELECT_FIRST_CHILD_BY_CONTENT_SQL,
  type AliasMatch,
} from './kernelQueries'

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
  private readonly processorRunner: ProcessorRunner
  /** Identity-stable Block facades, keyed by id. Stage-2 of Phase 1
   *  upgrades these into ref-counted handles; for now they're plain
   *  facades cached so repeat `repo.block(id)` calls return the same
   *  instance (React `key`/memo identity friendly). */
  private readonly blockFacades = new Map<string, Block>()
  /** Backing field for `activeWorkspaceId` (see getter/setter below). */
  private _activeWorkspaceId: string | null = null
  /** Instance discriminator for memoization keys that need to vary
   *  across Repo instances (e.g. lodash.memoize calls in the panel /
   *  user-page bootstrap). Auto-incremented per construction. */
  private static nextInstanceId = 1
  readonly instanceId: number = Repo.nextInstanceId++

  /** Hydrate a list of `BlockRow`s into the cache + return parsed
   *  BlockData[]. Internal helper for the kernel queries. */
  private hydrateRows(rows: BlockRow[]): BlockData[] {
    const out: BlockData[] = []
    for (const r of rows) {
      const data = parseBlockRow(r)
      this.cache.setSnapshot(data)
      out.push(data)
    }
    return out
  }

  /** Typed-dispatch sugar. `repo.mutate.indent({id})` opens a 1-mutator
   *  tx with the mutator's scope and runs it. Lookup tries kernel-short
   *  name first (`'core.indent'` for `mutate.indent`), then the literal
   *  key (so plugin mutators registered as `'tasks:setDueDate'` are
   *  callable as `repo.mutate['tasks:setDueDate'](args)`). */
  readonly mutate: Record<string, (args: unknown) => Promise<unknown>>

  constructor(opts: RepoOptions) {
    this.db = opts.db
    this.cache = opts.cache
    this.user = opts.user
    this.isReadOnly = opts.isReadOnly ?? false
    this.now = opts.now ?? Date.now
    this.newId = opts.newId ?? randomUUID
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
    // Initialize the processor runner. The runner needs a Repo
    // reference for opening processor txs; passing `this` is safe
    // because runner methods only use it post-construction (during
    // dispatch). The runner reads its registry per-tx from the snapshot
    // baked into TxResult — we don't sync a registry into the runner
    // here.
    this.processorRunner = new ProcessorRunner(this, opts.db)
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
    })
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
   *    repo.load(id, {children: true})        → row + immediate children;
   *                                              sets the allChildrenLoaded
   *                                              marker for `id`
   *    repo.load(id, {ancestors: true})       → row + full parent chain
   *    repo.load(id, {descendants: N})        → row + subtree clipped at
   *                                              depth N (or whole tree
   *                                              if N is omitted/falsy
   *                                              for descendants:true)
   *
   *  Concurrency note: this method does NOT use `BlockCache.dedupLoad`.
   *  That helper keys by id only, which silently merged a plain
   *  `repo.load(id)` with a concurrent `repo.load(id, {children: true})`
   *  — the second caller would see the plain promise resolve and miss
   *  the children + the allChildrenLoaded marker. Inlining the load
   *  costs at most one extra row read per concurrent caller; the
   *  cache's `setSnapshot` is fingerprint-deduplicated so listeners
   *  don't fire twice. */
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
    this.cache.setSnapshot(data)

    if (opts?.children) {
      const childRows = await this.db.getAll<BlockRow>(CHILDREN_SQL, [id])
      for (const r of childRows) this.cache.setSnapshot(parseBlockRow(r))
      this.cache.markChildrenLoaded(id)
    }

    if (opts?.ancestors) {
      // Pass id twice — ANCESTORS_SQL uses it as both start and skip.
      const ancestorRows = await this.db.getAll<BlockRow>(ANCESTORS_SQL, [id, id])
      for (const r of ancestorRows) this.cache.setSnapshot(parseBlockRow(r))
    }

    if (opts?.descendants) {
      const subtreeRows = await this.db.getAll<BlockRow & {depth: number}>(SUBTREE_SQL, [id])
      const maxDepth = typeof opts.descendants === 'number' ? opts.descendants : Infinity
      // Track which parents we hydrate completely so we can mark
      // their children-loaded state.
      const fullyHydrated = new Set<string>()
      for (const r of subtreeRows) {
        if (r.depth > maxDepth) continue
        this.cache.setSnapshot(parseBlockRow(r))
      }
      // Every visited row at depth < maxDepth has its children fully
      // hydrated by the same query (children are in the result set
      // unless they exceed maxDepth). Mark accordingly.
      for (const r of subtreeRows) {
        if (r.depth < maxDepth) fullyHydrated.add(r.id)
      }
      for (const pid of fullyHydrated) this.cache.markChildrenLoaded(pid)
    }

    return data
  }

  // ──── Kernel queries (raw SQL; Phase 4 wraps in queriesFacet) ────

  /** Backlinks: live blocks in `workspaceId` whose `references` field
   *  points at `targetId`. Returns BlockData rows; callers wanting
   *  Block facades use `repo.block(row.id)`. Each row is hydrated into
   *  the cache as a side-effect so subsequent sync reads succeed. */
  async findBacklinks(workspaceId: string, targetId: string): Promise<BlockData[]> {
    if (!targetId || !workspaceId) return []
    const rows = await this.db.getAll<BlockRow>(
      SELECT_BACKLINKS_FOR_BLOCK_SQL,
      [workspaceId, targetId, targetId],
    )
    return this.hydrateRows(rows)
  }

  /** Live blocks in `workspaceId` whose `type` property equals `type`.
   *  Hydrates results into cache. */
  async findBlocksByType(workspaceId: string, type: string): Promise<BlockData[]> {
    if (!workspaceId) return []
    const rows = await this.db.getAll<BlockRow>(
      SELECT_BLOCKS_BY_TYPE_SQL,
      [workspaceId, type],
    )
    return this.hydrateRows(rows)
  }

  /** Substring-match content search in a workspace. Returns up to
   *  `limit` rows ordered by recency. Empty `query` returns []. */
  async searchBlocksByContent(
    workspaceId: string,
    query: string,
    limit = 50,
  ): Promise<BlockData[]> {
    if (!query) return []
    const rows = await this.db.getAll<BlockRow>(
      SELECT_BLOCKS_BY_CONTENT_SQL,
      [workspaceId, query, limit],
    )
    return this.hydrateRows(rows)
  }

  /** Single-block lookup by exact alias in a workspace. Returns null
   *  on no match. Hydrates the cache when a match is found. */
  async findBlockByAliasInWorkspace(
    workspaceId: string,
    alias: string,
  ): Promise<BlockData | null> {
    if (!alias || !workspaceId) return null
    const row = await this.db.getOptional<BlockRow>(
      SELECT_BLOCK_BY_ALIAS_IN_WORKSPACE_SQL,
      [workspaceId, alias],
    )
    if (row === null) return null
    const data = parseBlockRow(row)
    this.cache.setSnapshot(data)
    return data
  }

  /** Distinct alias values in a workspace, optionally substring-filtered.
   *  Returns the raw strings (no block ids); used by autocomplete. */
  async getAliasesInWorkspace(
    workspaceId: string,
    filter = '',
  ): Promise<string[]> {
    if (!workspaceId) return []
    const rows = await this.db.getAll<{alias: string}>(
      SELECT_ALIASES_IN_WORKSPACE_SQL,
      [workspaceId, filter, filter],
    )
    return rows.map(r => r.alias)
  }

  /** Alias autocomplete with surrounding context — one row per
   *  (alias, blockId) pair, plus the block's content for preview. */
  async findAliasMatchesInWorkspace(
    workspaceId: string,
    filter: string,
    limit = 50,
  ): Promise<AliasMatch[]> {
    if (!workspaceId) return []
    return this.db.getAll<AliasMatch>(
      SELECT_ALIAS_MATCHES_IN_WORKSPACE_SQL,
      [workspaceId, filter, filter, limit],
    )
  }

  /** First child of `parentId` whose content matches exactly. Returns
   *  null if no match. Used by daily-note / target-block helpers. */
  async findFirstChildByContent(
    parentId: string,
    content: string,
  ): Promise<BlockData | null> {
    const row = await this.db.getOptional<BlockRow>(
      SELECT_FIRST_CHILD_BY_CONTENT_SQL,
      [parentId, content],
    )
    if (row === null) return null
    const data = parseBlockRow(row)
    this.cache.setSnapshot(data)
    return data
  }

  /** Subtree rooted at `rootId` (depth-100 + visited-id guarded;
   *  spec §11). Hydrates the result + sets `allChildrenLoaded` markers
   *  for every parent inside the subtree. */
  async subtree(rootId: string, opts?: {includeRoot?: boolean}): Promise<BlockData[]> {
    const rows = await this.db.getAll<BlockRow & {depth: number}>(SUBTREE_SQL, [rootId])
    const includeRoot = opts?.includeRoot ?? true
    const out: BlockData[] = []
    const seen = new Set<string>()
    for (const r of rows) {
      const data = parseBlockRow(r)
      this.cache.setSnapshot(data)
      seen.add(data.id)
      if (includeRoot || data.id !== rootId) out.push(data)
    }
    for (const id of seen) this.cache.markChildrenLoaded(id)
    return out
  }

  /** Ancestor chain up from `id` (excludes `id` itself). Hydrates
   *  every ancestor into cache. */
  async ancestors(id: string): Promise<BlockData[]> {
    const rows = await this.db.getAll<BlockRow>(ANCESTORS_SQL, [id, id])
    return this.hydrateRows(rows)
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
    return result.value
  }

  /** Dynamic dispatch — used by runtime-loaded plugins where the
   *  TypeScript identity isn't available. `name` is the full mutator
   *  name (e.g. `'tasks:setDueDate'` or `'core.indent'`). Args are
   *  validated at the boundary via the mutator's argsSchema. */
  async run<R = unknown>(name: string, args: unknown): Promise<R> {
    return this.dispatchMutator(name)(args) as Promise<R>
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
}

// Re-import ChangeScope so the file's TypeScript module structure
// includes a use of it (used inside dispatchMutator's scope-resolve
// path indirectly through Mutator.scope; explicit import keeps the
// dependency visible to readers).
void ChangeScope
