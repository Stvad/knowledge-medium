import type { ChangeScope } from './changeScope'
import type { Schema } from './schema'
import type { Tx } from './tx'

export interface Mutator<Args = unknown, Result = void> {
  readonly name: string
  readonly argsSchema: Schema<Args>
  readonly resultSchema?: Schema<Result>
  readonly apply: (tx: Tx, args: Args) => Promise<Result>
  /** Optional: human-readable description of this call (used as the
   *  default `description` for the wrapping tx in `repo.mutate.X`). */
  readonly describe?: (args: Args) => string
  /** Static or arg-derived scope. The wrapper resolves to a concrete
   *  scope before opening the tx (engine needs it for `tx_context.source`
   *  + read-only gating, both pre-user-fn). */
  readonly scope: ChangeScope | ((args: Args) => ChangeScope)
}

/** Plugin-augmentable type registry. Static plugins augment via
 *  `declare module '@/data/api'`; dynamic plugins use string-keyed
 *  access via `repo.run('name', args)`. See §12.
 *  The empty body is the whole point — `interface` lets plugins layer
 *  in members from outside this module via declaration merging, which
 *  `type` and `Record<string, ...>` can't. */
// eslint-disable-next-line @typescript-eslint/no-empty-object-type
export interface MutatorRegistry { /* augmented per plugin */ }

/** Variance-erased mutator type for storage in heterogeneous collections
 *  (the engine's mutator registry, `mutatorsFacet`'s contributions, etc).
 *
 *  `Mutator<unknown, unknown>` doesn't work because `Args` is contravariant:
 *  a `Mutator<{x: number}, void>` can NOT be safely stored as a
 *  `Mutator<unknown, unknown>` (the latter could be called with any
 *  unknown, but the former only accepts `{x: number}`). The conventional
 *  TypeScript escape for this case is `any` — it opts out of variance
 *  checking for the registry slot while keeping the per-mutator types
 *  intact at definition sites. Concrete callers (`repo.mutate.X`,
 *  `tx.run(mutator, args)`) work against the precise types via the
 *  `MutatorRegistry` augmentation channel. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type AnyMutator = Mutator<any, any>

/** Helper for plugin authors. Returns the mutator unchanged but
 *  type-narrows `Args` / `Result` from `argsSchema` / `resultSchema`
 *  inferred types. */
export const defineMutator = <Args, Result = void>(
  mutator: Mutator<Args, Result>,
): Mutator<Args, Result> => mutator
