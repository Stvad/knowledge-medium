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
