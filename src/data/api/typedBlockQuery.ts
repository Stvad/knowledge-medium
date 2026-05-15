export interface TypedBlockQueryReferenceFilter {
  readonly id: string
  readonly sourceField?: string
}

/** A single block predicate. Compiled against either the block itself
 *  (`scope: 'self'`, default) or the block-or-any-of-its-ancestors
 *  (`scope: 'ancestor'`). All sub-fields within one predicate AND
 *  together. Multiple predicates AND across in `match`, NOR across in
 *  `exclude`.
 *
 *  The `id` field is the "block has this id" primitive. Useful with
 *  ancestor scope to filter for "block is contained in page X" without
 *  requiring X to be referenced — e.g. backlinks-on-a-daily-note
 *  filtering by which page their context lives in. */
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
