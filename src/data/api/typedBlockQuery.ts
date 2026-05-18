export interface TypedBlockQueryReferenceFilter {
  readonly id: string
  readonly sourceField?: string
}

/** Operator object accepted inside `BlockPredicate.where[name]`. The
 *  scalar/null shorthand still works: a bare value compiles as
 *  equality, `null` compiles as `IS NULL`. The object form is needed
 *  for everything else.
 *
 *  Exactly one operator key per object — multiple keys would force an
 *  AND-vs-OR interpretation that's better expressed by combining
 *  predicates in `match` / `exclude`. The runtime parser rejects
 *  multi-key objects to keep the surface unambiguous.
 *
 *  Operand types: each scalar operand goes through `codec.where.encode`
 *  the same way scalar shorthand does, so `{ lt: new Date('2026-01-01') }`
 *  on a date-codec property and `{ gt: 5 }` on a number-codec property
 *  validate identically to their equality-form counterparts. `between`
 *  is inclusive on both ends. `exists` takes a boolean — `true` for
 *  "property is set" (`IS NOT NULL`), `false` for "unset" (`IS NULL`,
 *  same as the `null` shorthand).
 *
 *  `target` is the ref-traversal operator. Valid only on `ref`-typed
 *  (and `refList`-typed) properties; the operand is an inner where-map
 *  compiled against the referenced block's `properties_json`. Lets
 *  callers ask "this ref points to a block whose <inner where> holds"
 *  without bouncing through `referencedBy`, which only knows equality
 *  on the target id. Example — find blocks whose `next-review-date`
 *  ref points to a daily note whose `daily-note:date` is in the past:
 *
 *    where: {
 *      'next-review-date': {
 *        target: { 'daily-note:date': { lt: new Date() } }
 *      }
 *    }
 *
 *  The compiler stays plugin-agnostic — it doesn't know about
 *  daily-notes; the caller (typically UI) spells the target property
 *  name. */
export type WhereOperator =
  | { readonly eq: unknown }
  | { readonly lt: unknown }
  | { readonly lte: unknown }
  | { readonly gt: unknown }
  | { readonly gte: unknown }
  | { readonly between: readonly [unknown, unknown] }
  | { readonly exists: boolean }
  | { readonly target: Readonly<Record<string, unknown>> }

/** A single block predicate. Compiled against either the block itself
 *  (`scope: 'self'`, default) or the block-or-any-of-its-ancestors
 *  (`scope: 'ancestor'`). All sub-fields within one predicate AND
 *  together. Multiple predicates AND across in `match`, NOR across in
 *  `exclude`.
 *
 *  The `id` field is the "block has this id" primitive. Useful with
 *  ancestor scope to filter for "block is contained in page X" without
 *  requiring X to be referenced — e.g. backlinks-on-a-daily-note
 *  filtering by which page their context lives in.
 *
 *  `where[name]` values: scalar (equality), `null` (unset), or a
 *  `WhereOperator` object (`{ lt: v }`, `{ exists: true }`, etc.). See
 *  the `WhereOperator` doc for the operand contract. */
export interface BlockPredicate {
  readonly scope?: 'self' | 'ancestor'
  readonly id?: string
  readonly where?: Readonly<Record<string, unknown>>
  readonly referencedBy?: TypedBlockQueryReferenceFilter
}

export interface TypedBlockQuery {
  /** Defaults to Repo.activeWorkspaceId for the Repo wrapper methods. */
  readonly workspaceId?: string
  /** Contains any of these type ids. Empty/omitted means no type filter. */
  readonly types?: readonly string[]
  /** Self-scope shorthand: equivalent to a `match` entry with
   *  `scope: 'self'` carrying these `where` filters. Kept as a
   *  top-level field so the common typed-block-query call sites stay
   *  terse. */
  readonly where?: Readonly<Record<string, unknown>>
  /** Self-scope shorthand: equivalent to a `match` entry with
   *  `scope: 'self'` carrying this `referencedBy`. Drives the
   *  candidate-set selection in the compiler — when present, the
   *  scan starts from `block_references` and the ancestor walk (if
   *  any) is seeded from that narrow set. */
  readonly referencedBy?: TypedBlockQueryReferenceFilter
  /** Additional ANDed predicates. Each predicate carries its own
   *  scope, so the same query can mix block-itself and block-or-any-
   *  ancestor filters. */
  readonly match?: readonly BlockPredicate[]
  /** NORed predicates: a block matches iff none of these match. Same
   *  predicate shape as `match`. */
  readonly exclude?: readonly BlockPredicate[]
  /** Result ordering. Default `created-asc`. Backlinks panels use
   *  `created-desc` to put newest sources first. */
  readonly order?: 'created-asc' | 'created-desc'
}

export interface ResolvedTypedBlockQuery extends Omit<TypedBlockQuery, 'workspaceId'> {
  readonly workspaceId: string
}
