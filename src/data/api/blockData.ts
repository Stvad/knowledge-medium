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
  /** Non-null when the block's whole content is exactly one reference token
   *  (`((uuid))` / `[[alias]]`) — the resolved target block id; for property
   *  field rows this is the schema definition block's `fieldId`. LOCAL-only
   *  derived state: never synced, re-derived per device by
   *  `core.deriveReferenceTarget` (same tx) and the sync materializer
   *  (arrival). Optional-in: hand-built literals may omit it; rows parsed
   *  from storage always carry `string | null` (`parseBlockRow` normalizes
   *  absence to `null`), so treat `undefined` as `null`. */
  referenceTargetId?: string | null
  /** LOCAL derived bit (§7 grammar box): true when the row's whole trimmed
   *  content is the `::`-marked field form — `::` + one reference span, any
   *  span form. Pure syntax, stamped by the same derive pass as
   *  `referenceTargetId` whether or not the span resolves (only the target
   *  column late-binds). Never synced; rebuilt from content by the same
   *  repair paths. Optional-in like `referenceTargetId`: hand-built literals
   *  may omit it; rows parsed from storage always carry a boolean
   *  (`parseBlockRow` normalizes NULL/absence to `false` — ordinary rows are
   *  never stamped `0`, the bit is 1 or NULL on disk). */
  isFieldForm?: boolean
  orderKey: string
  content: string
  /** Codec-encoded property values keyed by `PropertySchema.name`.
   *  Decoded on read at the four boundary sites only; storage and cache
   *  always hold this encoded shape. */
  properties: Record<string, unknown>
  references: BlockReference[]
  createdAt: number
  /** Pure row-version / sync-gate discriminator: advances on every
   *  content-changing write (locally monotonic per row, server-enforced
   *  monotonic). NOT a display timestamp — see `userUpdatedAt`. A
   *  speculative deterministic-id mint stamps `0` (the "pristine" sentinel
   *  the reconcile gate lets yield to the server). */
  updatedAt: number
  /** User-facing "last edited" timestamp. What display/sort/recency
   *  consumers read. Frozen on `{skipMetadata}` bookkeeping writes (which
   *  still advance `updatedAt`), so a backlink reindex or alias bookkeeping
   *  write does not float a block to the top of "recent". */
  userUpdatedAt: number
  createdBy: string
  updatedBy: string
  deleted: boolean
}

/** A block plus its `depth` relative to a subtree root (0 = the root,
 *  parent + 1 otherwise). This is the element shape `repo.query.subtree`
 *  returns. `depth` describes the row's position in *that* subtree, not the
 *  block itself (the same block sits at different depths under different
 *  roots), so it lives only on the result element — never on the shared,
 *  cached `BlockData`. */
export interface SubtreeRow extends BlockData {
  depth: number
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
  'content' | 'referenceTargetId' | 'isFieldForm' | 'properties' | 'references'
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
  /** Pre-resolved local derived column (see `BlockData.referenceTargetId`).
   *  Machinery that creates reference rows with a known target (property
   *  field-row materialization) passes it so the row is recognizable in the
   *  same tx even when name resolution would miss; the derive processor
   *  keeps it consistent with content afterwards. */
  referenceTargetId?: string | null
  /** Pre-stamped local derived bit (see `BlockData.isFieldForm`) — the
   *  born-classified half of field-row minting (§9): machinery that creates
   *  `::((fieldId))` rows passes `true` so the row classifies in the same
   *  single pass, no reliance on the derive processor running afterwards. */
  isFieldForm?: boolean
  orderKey: string
  content?: string
  properties?: Record<string, unknown>
  references?: BlockReference[]
}
