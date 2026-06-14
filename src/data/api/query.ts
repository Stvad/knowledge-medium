import type { Schema } from './schema'
import type { BlockData } from './blockData'
// Type-only — no runtime cycle. Mirrors ProcessorCtx.repo's pattern so
// query resolvers that need to compose existing data-layer surfaces do
// not have to cast from unknown.
import type { Repo } from '../repo'

/** A dependency a query declares while resolving. Drives invalidation
 *  matching (§9.2). Built-in queries declare these from their `resolve`
 *  bodies (e.g. `parent-edge` for tree handles, `row` for everything
 *  visited). Plugin queries do the same.
 *
 *  Plugin queries can declare channel/key dependencies through
 *  `{kind:'plugin', channel, key}`. Plugin-owned invalidation rules emit
 *  matching channel/key changes after tx commits and sync-applied row
 *  events, keeping feature-specific invalidation logic out of core.
 */
export type Dependency =
  | { kind: 'row'; id: string }
  | { kind: 'parent-edge'; parentId: string }
  | { kind: 'workspace'; workspaceId: string }
  | { kind: 'table'; table: string }
  | { kind: 'plugin'; channel: string; key: string }

/** Read-only SQL surface available to a query resolver. Sees committed
 *  state at resolve time. Intentionally narrower than `PowerSyncDatabase`
 *  — no `execute`, no `writeTransaction` — so the type prevents
 *  accidental writes through this handle. */
export interface QueryReadDb {
  getOptional<T>(sql: string, params?: unknown[]): Promise<T | null>
  getAll<T>(sql: string, params?: unknown[]): Promise<T[]>
  get<T>(sql: string, params?: unknown[]): Promise<T>
}

/** Resolver context. `db` is the committed-state read surface; writes
 *  through `db` are unsupported. `repo` is the owning Repo instance for
 *  composing existing query/read surfaces when a resolver needs them. */
export interface QueryCtx {
  /** Raw SQL reads against committed state. The narrow shape is
   *  deliberate: `.execute()` / `.writeTransaction()` are absent. */
  db: QueryReadDb
  repo: Repo
  /** Hydrate full block rows into the cache and (by default) declare a
   *  `{kind:'row', id}` dep on each. Use this whenever the resolver has
   *  block rows in hand.
   *
   *  `opts.declareRowDeps` (default `true`) toggles the per-row dep
   *  contribution. Set to `false` for cache-priming-only calls — id-
   *  list queries whose result depends only on parent edges, or
   *  hydrating queries whose full sensitivity surface is already
   *  covered by plugin-channel deps. Per-row deps fan out invalidations
   *  on edits that can't affect the result (parent moves, unrelated
   *  property writes) and inflate handle dep count on large result
   *  sets, so opt out when a narrower dep covers everything. */
  hydrateBlocks(
    rows: ReadonlyArray<Record<string, unknown>>,
    opts?: {declareRowDeps?: boolean},
  ): BlockData[]
  /** Declare a dependency; engine uses these to invalidate this handle. */
  depend(dep: Dependency): void
  /** Run another registered query *inline, in this resolver's dependency
   *  scope*. No separate handle is created — the sub-query is just a
   *  reusable resolver, and the calling handle stays the unit of caching
   *  + invalidation. Compose `core.*` queries (or any registered query)
   *  instead of re-deriving their SQL.
   *
   *  `opts.deps` controls how the sub-query's declared deps land:
   *   - `'inherit'` (default): the sub-query's `depend` calls and its
   *     `hydrateBlocks` row deps accumulate on *this* handle. The safe
   *     direction — over-declaring only over-invalidates.
   *   - `'none'`: run it for the data only and declare *no* deps; the
   *     caller then declares its own (narrower) dep set. Use when you
   *     know your true sensitivity is narrower than the generic query's.
   *     Under-declaring leaves the handle stale, so opt in deliberately.
   *
   *  Typing footgun: because `run` resolves over `keyof QueryRegistry`, a
   *  query that BOTH returns its `ctx.run(...)` result directly AND
   *  augments `QueryRegistry` with `typeof itself` creates a circular
   *  inference (`QueryRegistry` → `typeof thisQuery` → its initializer →
   *  `ctx.run`). Give such a query an explicit `Query<Args, Result>` const
   *  type annotation to break the loop (see `backlinksForBlockQuery`).
   *  Queries that return a locally-built value are unaffected. */
  run<K extends keyof QueryRegistry>(
    name: K,
    args: QueryArgsOf<QueryRegistry[K]>,
    opts?: {deps?: 'inherit' | 'none'},
  ): Promise<QueryResultOf<QueryRegistry[K]>>
}

/** Extract the args / result types of a registered query type (the values
 *  stored in `QueryRegistry`). `any` in the unused slot sidesteps the
 *  contravariance that would otherwise block the `infer` match — same
 *  rationale as `AnyQuery`. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type QueryArgsOf<Q> = Q extends Query<infer A, any> ? A : never
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type QueryResultOf<Q> = Q extends Query<any, infer R> ? R : never

export interface Query<Args, Result> {
  readonly name: string
  readonly argsSchema: Schema<Args>
  readonly resultSchema: Schema<Result>
  readonly resolve: (args: Args, ctx: QueryCtx) => Promise<Result>
}

/** Plugin-augmentable type registry. Empty by design so plugin authors
 *  can layer in members from their own module via declaration merging. */
// eslint-disable-next-line @typescript-eslint/no-empty-object-type
export interface QueryRegistry { /* augmented per plugin */ }

/** Variance-erased query type for storage in heterogeneous collections
 *  (the engine's query registry, `queriesFacet`'s contributions, etc).
 *
 *  Same rationale as `AnyMutator`: `Query<Args, Result>` is contravariant
 *  in `Args` (the resolver's args parameter) and so a typed plugin
 *  query can't be assigned to `Query<unknown, unknown>` under
 *  `strictFunctionTypes`. The conventional escape is `any`, which opts
 *  out of variance for the registry slot while keeping per-query types
 *  intact at definition sites. Concrete callers (`repo.query.X`,
 *  `repo.runQuery('name', ...)`) recover precise types via the
 *  `QueryRegistry` augmentation. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type AnyQuery = Query<any, any>

export const defineQuery = <Args, Result>(
  query: Query<Args, Result>,
): Query<Args, Result> => query
