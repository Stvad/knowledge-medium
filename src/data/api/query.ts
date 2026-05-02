import type { Schema } from './schema'
import type { BlockData } from './blockData'

/** A dependency a query declares while resolving. Drives invalidation
 *  matching (§9.2). Built-in queries declare these from their `resolve`
 *  bodies (e.g. `parent-edge` for tree handles, `row` for everything
 *  visited). Plugin queries do the same.
 *
 *  `backlink-target`: a handle that depends on "the set of source rows
 *  pointing at this id" — i.e. `core.backlinks({id})`. The fast path +
 *  sync tail compute the symmetric difference of `references_json`
 *  target ids per touched row and add the diff to
 *  `ChangeNotification.backlinkTargets`. A change that doesn't alter
 *  the set of targets a source references (a content edit on a source
 *  row, a focus-state UI write) does NOT add anything to
 *  `backlinkTargets` and so does not invalidate any backlinks handle.
 */
export type Dependency =
  | { kind: 'row'; id: string }
  | { kind: 'parent-edge'; parentId: string }
  | { kind: 'workspace'; workspaceId: string }
  | { kind: 'table'; table: string }
  | { kind: 'backlink-target'; id: string }

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
