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
import { mutatorsFacet } from './facets'
import { ANCESTORS_SQL, CHILDREN_SQL, SUBTREE_SQL } from './treeQueries'

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
  registerKernel?: boolean
}

export class Repo {
  readonly db: PowerSyncDb
  readonly cache: BlockCache
  user: User
  isReadOnly: boolean

  private readonly now: () => number
  private readonly newId: () => string
  private readonly newTxSeq: () => number
  private mutators: Map<string, AnyMutator> = new Map()

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
    // Register kernel mutators by default. setFacetRuntime overrides
    // with the merged kernel + plugin registry once a runtime is
    // supplied; callers can also pass `registerKernel: false` to start
    // empty (used by tests that want explicit registration semantics).
    if (opts.registerKernel ?? true) {
      this.registerMutators(KERNEL_MUTATORS)
    }
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
    })
    // afterCommit jobs returned but not dispatched in stage 1.3 — the
    // post-commit processor framework lands in stage 1.5. Until then,
    // we keep them on the result for tests that want to verify
    // scheduling semantics; they don't fire and we don't leak them.
    void result.afterCommitJobs
    return result.value
  }

  /** Dynamic dispatch — used by runtime-loaded plugins where the
   *  TypeScript identity isn't available. `name` is the full mutator
   *  name (e.g. `'tasks:setDueDate'` or `'core.indent'`). Args are
   *  validated at the boundary via the mutator's argsSchema. */
  async run<R = unknown>(name: string, args: unknown): Promise<R> {
    return this.dispatchMutator(name)(args) as Promise<R>
  }

  /** Update the mutator registry from a FacetRuntime. Spec §8. Reads
   *  `mutatorsFacet` contributions; future stages will read the other
   *  data-layer facets (queries, properties, processors) here too.
   *  Replaces the current registry; kernel mutators must be present in
   *  the runtime if the caller wants them — pass them in via the
   *  static-facet bundle the kernel ships. */
  setFacetRuntime(runtime: FacetRuntime): void {
    const merged = runtime.read(mutatorsFacet)
    this.mutators = new Map(merged)
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
