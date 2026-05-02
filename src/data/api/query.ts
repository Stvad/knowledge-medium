import type { Schema } from './schema'
import type { BlockData } from './blockData'

/** A dependency a query declares while resolving. Drives invalidation
 *  matching (§9.2). Built-in queries declare these from their `resolve`
 *  bodies (e.g. `parent-edge` for tree handles, `row` for everything
 *  visited). Plugin queries do the same. */
export type Dependency =
  | { kind: 'row'; id: string }
  | { kind: 'parent-edge'; parentId: string }
  | { kind: 'workspace'; workspaceId: string }
  | { kind: 'table'; table: string }

/** Resolver context. `db` is the raw PowerSync handle for committed-state
 *  reads; writes through `db` are unsupported (use `repo.tx` / `ctx.tx`).
 *  The actual `PowerSyncDatabase` type is import-only — kept loose here so
 *  the data-layer api module isn't bound to PowerSync's type surface. */
export interface QueryCtx {
  /** Raw SQL reads against committed state. Treat as opaque from the
   *  api module's perspective; concrete callers narrow to
   *  `PowerSyncDatabase` at the resolver definition site. */
  db: unknown
  repo: unknown
  hydrateBlocks(rows: ReadonlyArray<Record<string, unknown>>): BlockData[]
  /** Declare a dependency; engine uses these to invalidate this handle. */
  depend(dep: Dependency): void
}

export interface Query<Args, Result> {
  readonly name: string
  readonly argsSchema: Schema<Args>
  readonly resultSchema: Schema<Result>
  readonly resolve: (args: Args, ctx: QueryCtx) => Promise<Result>
  /** Intent-marker for the invalidation engine. Currently a no-op at
   *  runtime — declared here so plugin authors can document the tables
   *  a query depends on, and so a future prefilter implementation has a
   *  field to read.
   *
   *  Why not auto-declare table deps from this field: precise queries
   *  (children/subtree/ancestors/backlinks/...) already declare
   *  parent-edge / row / workspace deps that cover their cases. Adding a
   *  table-coarse OR-dep on top means every blocks write anywhere
   *  matches, re-running SQL/hydration on every mounted handle (the hot
   *  path for `useChildIds` etc.). Plugin queries that genuinely need a
   *  coarse table-scan dep declare it explicitly:
   *  `ctx.depend({kind:'table', table:'blocks'})`.
   *
   *  v4.28: only `tables` is supported. */
  readonly coarseScope?: { tables?: string[] }
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
