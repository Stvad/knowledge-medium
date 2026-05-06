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
  'content' | 'properties' | 'references'
>>

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
  orderKey: string
  content?: string
  properties?: Record<string, unknown>
  references?: BlockReference[]
}
