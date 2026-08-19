import { z } from 'zod'

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
  /** Required. Callers that want the user's currently-active workspace
   *  use `repo.queryActiveWorkspace` / `repo.subscribeActiveWorkspace`
   *  (or pass `repo.activeWorkspaceId` explicitly). Making this field
   *  required at the type level prevents background flows, import runs,
   *  and any code that operates on a workspace other than the
   *  currently-active one from silently mis-scoping when the user
   *  switches workspaces mid-flight (see PR #47 review). */
  readonly workspaceId: string
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

/** Historically the "post-default-resolution" shape used internally;
 *  now that `TypedBlockQuery.workspaceId` is required at the type level
 *  the two shapes are identical. Kept as an alias for back-compat with
 *  internal call sites that name the resolved form explicitly. */
export type ResolvedTypedBlockQuery = TypedBlockQuery

/** Runtime validators for the predicate language above. Co-located with the
 *  types so a field added to `BlockPredicate` / `TypedBlockQueryReferenceFilter`
 *  can't silently drift from its validator. Shared by the kernel typed-block
 *  query and the backlinks / grouped-backlinks plugins. Exposed as bare objects;
 *  each call site applies `.optional()` / `.array()` as it needs. */
export const referenceFilterSchema = z.object({
  id: z.string(),
  sourceField: z.string().optional(),
})

export const blockPredicateSchema = z.object({
  scope: z.enum(['self', 'ancestor']).optional(),
  id: z.string().optional(),
  where: z.record(z.string(), z.unknown()).optional(),
  referencedBy: referenceFilterSchema.optional(),
})

export const backlinksFilterSchema = z.object({
  include: z.array(blockPredicateSchema).optional(),
  exclude: z.array(blockPredicateSchema).optional(),
})
