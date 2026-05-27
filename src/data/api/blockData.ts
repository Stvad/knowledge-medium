/** Outgoing reference parsed from content or a ref-typed property. For
 *  wikilinks `[[Inbox]]`, `alias` is the user-typed text and `id` is the
 *  resolved target. For block refs `((uuid))` and property refs,
 *  `alias === id` so content wikilink rendering doesn't accidentally
 *  resolve through non-wikilink edges. */
export interface BlockReference {
  /** Resolved target block id. */
  id: string
  /** Original alias text from the source content (preserved so wikilink
   *  rendering can show the alias the user typed, which may differ from
   *  the target's current name/aliases). */
  alias: string
  /** Empty/omitted for content refs; set to `PropertySchema.name` for
   *  refs projected from typed properties. */
  sourceField?: string
}

/** Domain shape — public, camelCase. SQL columns are snake_case
 *  (`BlockRow`) and JSON-encoded; `parseBlockRow` / `blockToRow` are the
 *  only places either shape leaks into the other. See spec §4.1.1. */
export interface BlockData {
  id: string
  workspaceId: string
  parentId: string | null
  /** Non-null when the block's whole content is a reference to another
   *  block/definition. For property fields, this points at
   *  `PropertySchema.fieldId`; their child rows hold the value(s). */
  referenceTargetId: string | null
  orderKey: string
  content: string
  /** Codec-encoded property values keyed by `PropertySchema.name`.
   *  Decoded on read at the four boundary sites only; storage and cache
   *  always hold this encoded shape. */
  properties: Record<string, unknown>
  references: BlockReference[]
  createdAt: number
  updatedAt: number
  createdBy: string
  updatedBy: string
  deleted: boolean
}

/** Patch shape for `tx.update` — non-structural data fields only.
 *  Structural (`parentId`, `orderKey` → `tx.move`), lifecycle (`deleted`
 *  → `tx.delete` / `tx.restore`), and metadata fields (`updatedAt` /
 *  `updatedBy` are engine-managed; `createdAt` / `createdBy` are
 *  immutable; `workspaceId` is fixed at creation) all have their own
 *  primitives. The undo machinery does NOT use `tx.update` — it has
 *  its own raw-row applier driven by snapshots. See spec §4.1.1. */
export type BlockDataPatch = Partial<Pick<
  BlockData,
  'content' | 'referenceTargetId' | 'properties' | 'references'
>>

/** Canonical form for a `BlockReference[]`. Sorted by
 *  `(sourceField, id, alias)` with `sourceField` defaulted to `''`, and
 *  exact duplicates collapsed. Every write of `references_json` runs
 *  through this so on-disk shape is independent of writer-side iteration
 *  order (Roam import's content-position order, the post-commit parser's
 *  alias-then-date-then-block-ref order, reprojection's
 *  retained-then-added order all converge), and downstream equality
 *  checks reduce to text compare. Consumers
 *  (`json_each`-driven backlinks index, `BACKLINKS_FOR_BLOCK_QUERY`,
 *  Map-keyed invalidation) treat references as a set, so the loss of
 *  insertion order is correctness-preserving. */
export const normalizeReferences = (
  refs: ReadonlyArray<BlockReference>,
): BlockReference[] => {
  const seen = new Set<string>()
  const out: BlockReference[] = []
  for (const ref of refs) {
    const sourceField = ref.sourceField ?? ''
    const key = `${sourceField}\u0000${ref.id}\u0000${ref.alias}`
    if (seen.has(key)) continue
    seen.add(key)
    // Omit the field entirely when empty so the serialised shape stays
    // minimal — JSON.stringify drops absent keys but emits `"":""` for
    // explicit empty strings.
    out.push(sourceField === ''
      ? {id: ref.id, alias: ref.alias}
      : {id: ref.id, alias: ref.alias, sourceField})
  }
  out.sort((a, b) => {
    const aSf = a.sourceField ?? ''
    const bSf = b.sourceField ?? ''
    if (aSf !== bSf) return aSf < bSf ? -1 : 1
    if (a.id !== b.id) return a.id < b.id ? -1 : 1
    if (a.alias !== b.alias) return a.alias < b.alias ? -1 : 1
    return 0
  })
  return out
}

/** Allowed shape for `tx.create`.
 *  - `id` optional (engine UUIDs when absent; deterministic-id helpers pass
 *    one in verbatim).
 *  - `createdAt` / `createdBy` / `updatedAt` / `updatedBy` not accepted —
 *    engine sets all four from `tx_context` at the write site.
 *  - `deleted` not accepted — fresh rows are live; soft-delete goes through
 *    `tx.delete`. */
export interface NewBlockData {
  id?: string
  workspaceId: string
  parentId: string | null
  referenceTargetId?: string | null
  orderKey: string
  content?: string
  properties?: Record<string, unknown>
  references?: BlockReference[]
}
