import type {
  BlockData,
  BlockDataPatch,
  NewBlockData,
} from './blockData'
import type { ChangeScope, TxSource } from './changeScope'
import type { AnyPropertyAssignment, AnyPropertySchema, PropertySchema } from './propertySchema'
import type { User } from './user'

/** Per-write opt: skip the engine's automatic `updatedAt`/`updatedBy` bump
 *  (and `createdAt`/`createdBy` on `tx.create`). Used by bookkeeping writes
 *  whose state isn't user intent — e.g. parseReferences updating
 *  `references`. User-facing mutators should not set this. */
export interface TxWriteOpts {
  skipMetadata?: boolean
}

/** Insert-only opts (`tx.create` / `tx.createOrGet`). `systemMint` is
 *  deliberately NOT on the shared {@link TxWriteOpts}: a row may only be
 *  born as a speculative engine default, never *promoted* into one by a
 *  later update — so `tx.update(..., {systemMint})` is a type error by
 *  construction. When set, the inserted row stamps `updated_at = 0` (the
 *  pristine sentinel the reconcile gate's stamp-0 exemption lets yield to the
 *  server); `created_by` / `updated_by` stay the REAL user (authorship is no
 *  longer the discriminator). Same-tx follow-up writes HOLD `updated_at` at 0
 *  rather than advancing it — so the `addTypeInTx` / `setProperty` shaping
 *  every deterministic-id mint does uploads as one pristine default. The first
 *  real edit in a LATER tx ratchets the row-version off 0. Ignored alongside
 *  `skipMetadata` (a system mint is not a metadata-skipping bookkeeping write). */
export interface TxInsertOpts extends TxWriteOpts {
  systemMint?: boolean
  /** Import/restore path: stamp `created_at` (origin) + `user_updated_at`
   *  (display "last edited") from a trusted external source — e.g. Roam
   *  `create-time` / `edit-time` — instead of `now()`. The row-version
   *  `updated_at` is NEVER sourced: it stays the engine's monotonic sync
   *  discriminator (born at `now`, or `0` under `systemMint`), so a
   *  historical value can surface in display/recency without regressing the
   *  server-enforced sync gate. `created_by` / `updated_by` stay the real
   *  acting user (external author ids don't map to our user ids). Ignored
   *  alongside `skipMetadata` (a 0-sentinel bookkeeping insert carries no
   *  source provenance). */
  sourceTimestamps?: {createdAt: number; userUpdatedAt: number}
}

/** Tx metadata exposed to mutators / processor `apply` bodies.
 *  - `txId` — uuid for this tx; written into `command_events.tx_id` and
 *    every `row_events.tx_id` for this tx.
 *  - `workspaceId` — pinned by the first write in the tx (see the
 *    single-workspace invariant in §5.3); `null` until the first write
 *    lands. `tx.afterCommit` throws `WorkspaceNotPinnedError` if called
 *    before that. */
export interface TxMeta {
  description?: string
  scope: ChangeScope
  user: User
  txId: string
  source: TxSource
  workspaceId: string | null
}

export type SiblingDirection = 'before' | 'after'

export interface SiblingAnchor {
  id: string
  workspaceId: string
  parentId: string | null
  orderKey: string
}

/** Forward declarations — these come from `mutator.ts` / `processor.ts`
 *  but are referenced by the Tx interface. */
import type { Mutator } from './mutator'
import type { ScheduledArgsFor } from './processor'
import type { SameTxEventPayload } from './sameTxProcessor'

/** Transactional session. Async reads, no arbitrary queries. Spec §5.3. */
export interface Tx {
  // ──── Reads ────

  /** Read with read-your-own-writes. Runs inside `db.writeTransaction`,
   *  so SQL natively sees writes already issued by this tx. Returns null
   *  for missing rows. */
  get(id: string): Promise<BlockData | null>

  /** Sync read: tx-private snapshots map first (own writes in this tx),
   *  then the shared (pre-tx) cache. Returns null if neither has it.
   *  The shared cache is mutated only on commit walk (v4.24), so
   *  outside-tx readers never observe in-flight tx state. */
  peek(id: string): BlockData | null

  // ──── Lifecycle ────

  /** Insert a new block. Throws `DuplicateIdError` on PK conflict.
   *  The engine preflights non-null parents and throws
   *  `ParentNotFoundError` / `ParentWorkspaceMismatchError` before the
   *  storage trigger's collapsed parent/workspace constraint can surface.
   *  Soft-deleted-parent is a kernel-mutator UX rule and does NOT fire on
   *  raw `tx.create` — see §4.7 Layer 1 (v4.30). */
  create(data: NewBlockData, opts?: TxInsertOpts): Promise<string>

  /** Insert OR fetch the live row at a deterministic id. **No tombstone
   *  resurrection in the primitive** — see §10.4. Throws
   *  `DeterministicIdCrossWorkspaceError` if the existing row is in a
   *  different workspace; throws `DeletedConflictError` if the existing
   *  row is soft-deleted. The shared `createOrRestoreTargetBlock` helper
   *  (§7, §13.1) catches `DeletedConflictError` and runs `tx.restore`.
   *  The insert path uses the same parent preflight as `tx.create`. */
  createOrGet(
    data: NewBlockData & { id: string },
    opts?: TxInsertOpts,
  ): Promise<{ id: string; inserted: boolean }>

  /** Soft-delete: sets `deleted = 1`. Fires the UPDATE trigger; row_events
   *  is emitted with `kind = 'soft-delete'` (see §4.3). */
  delete(id: string): Promise<void>

  /** Un-soft-delete a tombstoned row, optionally with a fresh data-field
   *  patch in the same UPDATE. Throws `BlockNotFoundError` if missing or
   *  `NotDeletedError` if already live. Used by
   *  `createOrRestoreTargetBlock` to recover from `DeletedConflictError`. */
  restore(id: string, patch?: BlockDataPatch, opts?: TxWriteOpts): Promise<void>

  // ──── Data-field updates (non-structural) ────

  /** Update non-structural data fields only (`content` /
   *  `referenceTargetId` / `references` / `properties`). Structural
   *  mutations have their own primitives. The patch type excludes
   *  `parentId`, `orderKey`, `workspaceId`, `deleted`, and metadata fields
   *  at the type level. */
  update(id: string, patch: BlockDataPatch, opts?: TxWriteOpts): Promise<void>

  /** Stamp the LOCAL derived columns — `reference_target_id` and
   *  `is_field_form` — and ONLY those, without advancing `updated_at`.
   *  Both are per-device reflections of `content` and are never
   *  uploaded, so re-deriving them (in `core.deriveReferenceTarget`'s
   *  same-tx amendment) must not mint an upload PATCH; `update(...,
   *  {skipMetadata})` would, because it still bumps `updated_at`. No-op
   *  when both already match. NOT for content-bundled retargets — those
   *  change a synced column and go through `update`. */
  stampReferenceTarget(id: string, targetId: string | null, isFieldForm: boolean): Promise<void>

  // ──── Tree moves (structural) ────

  /** Move a row to a new `(parentId, orderKey)`. For non-null parents the
   *  engine first throws `ParentNotFoundError` /
   *  `ParentWorkspaceMismatchError` when the target parent is invalid, then
   *  runs `isDescendantOf(target.parentId, id)` and throws `CycleError` if
   *  the new parent would be a descendant of `id` — load-bearing because FK
   *  and triggers can't structurally catch cycles. `target.parentId = null`
   *  re-roots the row (workspace root). */
  move(
    id: string,
    target: { parentId: string | null; orderKey: string },
    opts?: TxWriteOpts,
  ): Promise<void>

  // ──── Typed property primitives ────

  /** Resolve a schema through this transaction's row-workspace-bound winner
   * snapshot without writing. Rejects shadowed/ambiguous identity. Callers that
   * must stage several encoded values before one atomic raw update use this;
   * ordinary single-property writes should call `setProperty`. */
  resolvePropertySchema<T>(id: string, schema: PropertySchema<T>): Promise<PropertySchema<T>>

  /** `setProperty`: resolves schema identity, applies `codec.encode`, merges
   *  into the row's `properties` map, and writes through immediately.
   *  The updater overload runs inside this serialized tx after identity is
   *  accepted and receives `undefined` (not `defaultValue`) when absent.
   *  Bypassing codecs (raw `properties` writes) goes through `tx.update`. */
  setProperty<T>(
    id: string,
    schema: PropertySchema<T>,
    value: T,
    opts?: TxWriteOpts,
  ): Promise<void>
  setProperty<T>(
    id: string,
    schema: PropertySchema<T>,
    updater: (current: T | undefined) => T,
    opts?: TxWriteOpts,
  ): Promise<void>

  /** Remove ONE property key — the codec-aware counterpart to `setProperty`
   *  (there is no "set to undefined"). Resolves schema identity and checks
   *  scope exactly like `setProperty`, then drops just that key from the bag:
   *  a TARGETED delete, never a whole-bag replace, so it cannot clobber a
   *  sibling key a peer synced in. In a child-backed workspace it EAGERLY
   *  soft-deletes the field-row subtree for the key in the same tx (symmetric
   *  with setProperty's inline dual-write, recoverable via history — eager
   *  rather than left to the deferred MATERIALIZE pass, whose net-diff would
   *  miss a key set-then-unset in one tx); un-flipped it is a cell-only
   *  removal. No-op when the key is already absent. Throws
   *  `PropertySchemaIdentityError` if the schema has no resolvable definition,
   *  same as `setProperty`. */
  unsetProperty<T>(id: string, schema: PropertySchema<T>, opts?: TxWriteOpts): Promise<void>

  /** Atomically set and/or unset several properties in ONE bag rewrite. This
   *  is the batch form callers should reach for instead of a whole-bag
   *  `tx.update({properties})`: it applies a DELTA (set these, unset these,
   *  leave the rest alone), so it can't clobber a sibling key a peer synced
   *  in, and it's codec-aware throughout. Build `set` entries with
   *  `propertyValue(schema, value)` for per-entry type-checking. Every schema
   *  is resolved + scope-checked up front (the whole batch fails before any
   *  write on an unresolvable/mis-scoped entry). In a child-backed workspace it
   *  EAGERLY reconciles children in the same tx — creating/updating for sets,
   *  soft-deleting for unsets (unset wins on a key in both) — symmetric with
   *  `setProperty`/`unsetProperty`. A net no-op (bag unchanged) is skipped.
   *  `set` values are literals, not updater functions — read via `getProperty`
   *  first if you need the current value. */
  setProperties(
    id: string,
    changes: {
      readonly set?: readonly AnyPropertyAssignment[]
      readonly unset?: readonly AnyPropertySchema[]
    },
    opts?: TxWriteOpts,
  ): Promise<void>

  /** `getProperty`: reads SQL/cache and applies `codec.decode`. Returns
   *  the schema's `defaultValue` if the property is absent. */
  getProperty<T>(id: string, schema: PropertySchema<T>): Promise<T>

  /** Resolve a durable fieldId (definition block id) to its WINNING schema
   *  against `workspaceId`'s registry snapshot — the §9 recognition/
   *  projection primitive at tx level. Returns null for shadowed losers,
   *  orphans, and foreign workspaces (their field rows keep classifying at
   *  read sites but never project, so machinery that folds values into
   *  cells treats null as "this value exists only in the tree"). */
  resolvePropertyFieldSchema(
    workspaceId: string,
    fieldId: string,
  ): AnyPropertySchema | null

  /** §9 recognition, condition-3 checker: does `fieldId` name a definition
   *  this workspace's registry can resolve — shadow-tolerant (a shadowed
   *  loser COUNTS: its field rows keep classifying; only the name map and
   *  projection exclude it, §6). This is the classification predicate's
   *  fieldId half, exposed so `isPropertyFieldRow` reads the ONE checker
   *  instead of restating the disjunction. (The rename processor and the
   *  deferred migration batch answer the same question from their own
   *  captured resolvers rather than the tx-start one — deliberately, since
   *  those passes must not re-resolve at write time.) Synchronous — bound to
   *  the tx-start registry snapshot. */
  isPropertyFieldDefinition(workspaceId: string, fieldId: string): boolean

  /** The one properties-as-blocks predicate (PR #288 §6): is `workspaceId`
   *  flipped to child-backed properties (`workspaces.properties_migration`
   *  at or past 'children' — never an equality test)? It governs the
   *  read/write DIRECTION — the dual-write gate, the projection processors,
   *  the property-rename processor and the cell backfill — NOT whether a row
   *  is recognized as machinery, which is data-keyed. Cached per tx. Reads the local synced `workspaces` row; a missing row/column
   *  reads as un-flipped ('cell'). */
  isPropertyChildBackedWorkspace(workspaceId: string): Promise<boolean>

  /** The fieldIds `parentId` holds a TOMBSTONED field row for.
   *
   *  The one thing that separates "a cell key was never materialized" from "the
   *  property was DELETED through its children and this device's cell has not
   *  caught up" — the cell backfill's create-only path needs it before it may
   *  treat a key as history. On Tx rather than read alongside the candidate scan
   *  because the answer has to be taken under the same write lock as the
   *  materialization it gates: a tombstone arriving while the batch waits for the
   *  writer would otherwise be missed, and the pass would recreate the property
   *  and upload it.
   *
   *  Deleted rows only, since `childrenOf` already covers the live ones. Ordered
   *  `(order_key, id)`, and whole rows rather than a target set because the
   *  revival path (#787) restores these rather than only counting them: a
   *  restore that minted replacements abandoned the originals, so a property's
   *  row identity did not survive a delete→restore and two devices restoring
   *  the same block minted rival field rows for one definition. */
  tombstonedPropertyFieldRows(workspaceId: string, parentId: string): Promise<BlockData[]>

  /** Tombstoned children of `parentId`, ordered `(order_key, id)` — the
   *  complement of `childrenOf`, which is live-only. Exists for the revival
   *  path: bringing a tombstoned field row back means bringing its value
   *  children back with it, and those are invisible to every live-only read. */
  deletedChildrenOf(parentId: string): Promise<BlockData[]>

  /** For each of `names` that has a LIVE `property-schema` block in this
   *  workspace, the ids of those blocks — read inside the transaction.
   *
   *  Ids rather than a bare name set so a caller can tell the holders apart —
   *  de-duplicate against the row its own projection selected, and name the
   *  others when it has to report a collision.
   *
   *  DO NOT exclude your own deterministic id from this answer when the
   *  question is "who holds this name". That exclusion is only meaningful where
   *  the id is about to be WRITTEN, and as an answer about a NAME it hides the
   *  one holder guaranteed to win: a `systemMint` row is born at `createdAt` 0
   *  and `buildPropertyDefinitionRegistry` sorts ascending, so an unprojected
   *  copy at that id takes the name on the next rebuild while the caller
   *  backfills against whatever its projection picked. Keep "is this id mine to
   *  write through?" as its own question — `classifyOccupant` answers it.
   *
   *  Exists because the property-definition registry is a projector-driven
   *  PROJECTION: a definition applied by sync commits in its own transaction
   *  and is invisible to the registry until the projector ticks. A caller about
   *  to mint a definition cannot ask the registry whether the name is taken —
   *  it would mint a rival, and the loser of the winner machinery strands every
   *  field row bound to its fieldId. Inside the write lock no other writer can
   *  commit, so this answer holds for the rest of the transaction.
   *
   *  Reads the LAST occurrence of the name key, matching `JSON.parse` rather
   *  than `json_extract` — a raw write can produce a bag with a repeated key,
   *  and SQLite and JavaScript disagree about which one wins. */
  livePropertyDefinitionNames(
    workspaceId: string,
    names: readonly string[],
  ): Promise<Map<string, string[]>>

  // ──── Composition ────

  /** Compose another mutator. Sub-mutator's writes go through immediately;
   *  the parent's subsequent reads see them via SQL (read-your-own-writes
   *  inside the writeTransaction). No overlay arithmetic. */
  run<Args, R>(mutator: Mutator<Args, R>, args: Args): Promise<R>

  // ──── Within-tx tree primitives ────

  /** Children of `parentId`, ordered `(order_key, id)`, filtered
   *  `deleted = 0`. Reads SQL via the writeTransaction.
   *
   *  Returns EVERY child by default — property field/value rows included.
   *  This is the structural view: the actual tree, no hidden rows, so a
   *  traversal can never silently miss machinery it needs to carry (delete
   *  cascade, copy, merge). The display-visible view — which excludes
   *  recognized property field rows (PR #288 §9) — is opt-IN via
   *  `{hidePropertyChildren: true}`. Recognition is data-keyed, not
   *  flip-gated, so it prunes in every workspace: the cell→children backfill
   *  mints field rows while the workspace still reads cells.
   *
   *  Pass `null` to enumerate workspace-root rows (rows with
   *  `parent_id IS NULL`); the result is scoped to a workspace by
   *  one of three sources, in priority order:
   *    1. explicit `workspaceId` argument (use this when the tx
   *       hasn't pinned a workspace yet and you know the right one
   *       from a sibling/parent row you already read);
   *    2. the tx's pinned workspace (`tx.meta.workspaceId`) when set;
   *    3. throws `WorkspaceNotPinnedError` otherwise — returning
   *       cross-workspace rows is never safe for sibling-position
   *       computation.
   *  When `parentId !== null`, `workspaceId` is ignored — the parent
   *  row already constrains the query. */
  childrenOf(
    parentId: string | null,
    workspaceId?: string,
    options?: {hidePropertyChildren?: boolean},
  ): Promise<BlockData[]>

  /** Existence probe: does `parentId` have any child row? Live-only by
   *  default (`SELECT 1 … WHERE parent_id = ? AND deleted = 0 LIMIT 1`,
   *  index-served via the partial `idx_blocks_parent_order`).
   *  `{includeDeleted: true}` also counts tombstoned children — used to
   *  tell a row that ever had children (a real container, even one whose
   *  whole subtree was soft-deleted) apart from a never-populated stub.
   *  NOTE: the `includeDeleted` variant cannot use the partial
   *  (`deleted = 0`) index and falls back to a table scan, so reach for it
   *  only off hot paths. Cheaper than `childrenOf().length` — no row
   *  materialization, no `ORDER BY` sort, and stops at the first match. */
  hasChildren(parentId: string, opts?: {includeDeleted?: boolean}): Promise<boolean>

  /** Nearest live sibling before/after `anchor` in `(order_key, id)`
   *  order. Unlike `childrenOf`, this is a cursor lookup, so insertion
   *  mutators can compute adjacent order keys without loading a large
   *  sibling list. Root-level lookups are scoped by `anchor.workspaceId`
   *  for the same reason `childrenOf(null, workspaceId)` is. */
  adjacentSibling(anchor: SiblingAnchor, direction: SiblingDirection): Promise<BlockData | null>

  /** Parent of `childId`, or null if `childId` has no parent or doesn't
   *  exist. Reads SQL via the writeTransaction. */
  parentOf(childId: string): Promise<BlockData | null>

  /** True when `potentialAncestorId` is an ancestor of `id` (i.e. `id` is
   *  a descendant of `potentialAncestorId`). Walks `parent_id` up from `id`
   *  via the same bounded CTE (`IS_DESCENDANT_OF_SQL`) that backs
   *  `tx.move`'s cycle guard, so — like that guard — it does NOT filter
   *  soft-deleted nodes: a tombstone on the ancestor chain is still a real
   *  structural edge (#183). `id === potentialAncestorId` returns true. */
  isDescendantOf(id: string, potentialAncestorId: string): Promise<boolean>

  /** Look up the live block in `workspaceId` whose `aliases` property
   *  contains the exact `alias` text. Returns null when no such block
   *  exists. Tx-aware version of the kernel `core.aliasLookup` query;
   *  sees this tx's own writes via the writeTransaction.
   *
   *  Reads through the trigger-maintained `block_aliases` side index
   *  (clientSchema.ts) — exact match via `idx_block_aliases_ws_alias`.
   *  V1 enforces `(workspace_id, alias)` uniqueness for local writes
   *  via the `block_aliases_workspace_alias_unique` trigger, so this
   *  lookup typically resolves to a single row; the SQL's
   *  `ORDER BY created_at LIMIT 1` is a defense-in-depth tie-break
   *  for the sync-apply path that can still race-land duplicates
   *  from other clients. */
  aliasLookup(alias: string, workspaceId: string): Promise<BlockData | null>

  /** EVERY live block in `workspaceId` claiming the exact `alias`,
   *  oldest first. Use this instead of `aliasLookup` when the question
   *  is "is this alias claimed?" rather than "which block is named X?".
   *
   *  `aliasLookup`'s `LIMIT 1` tie-break silently hides co-claimants,
   *  and co-claimants are reachable: the uniqueness trigger only fires
   *  for local user txs, so sync-applied rows can land duplicates. A
   *  caller that vetoes on "any claimant that isn't mine" gets the wrong
   *  answer from the single-row form whenever the row it recognizes
   *  happens to be the oldest. Sees this tx's own writes. */
  aliasClaimants(alias: string, workspaceId: string): Promise<BlockData[]>

  /** Every alias `blockId` claims, straight out of the trigger-maintained
   *  index. `[]` for a tombstoned or missing row — a soft delete drops its
   *  entries while leaving the stored property bag alone.
   *
   *  The authoritative answer to "what names does this row hold", and not the
   *  same question as decoding its `alias` property. The trigger indexes
   *  `json_each(properties_json, '$.alias')` filtered to `typeof 'text'`,
   *  which yields values from a bare scalar and from an OBJECT as well as from
   *  an array, and stringifies a nested array. The string-list codec accepts
   *  none of those and throws for the whole bag if any entry is not a string.
   *  Re-deriving those semantics in TypeScript is whack-a-mole, and each shape
   *  missed silently RELEASES a name when the row is deleted. Sees this tx's
   *  own writes. */
  aliasesOf(blockId: string): Promise<string[]>

  // ──── Post-commit scheduling ────

  /** Schedule a follow-up post-commit job. Runs in its own
   *  writeTransaction after this tx commits; does NOT run if the tx
   *  rolls back. Throws `WorkspaceNotPinnedError` if no write has
   *  happened yet in this tx (so `meta.workspaceId` is still null). */
  afterCommit<P extends string>(
    processorName: P,
    args: ScheduledArgsFor<P>,
    options?: { delayMs?: number },
  ): void

  /** Emit a same-tx domain event. Event processors registered for
   *  `name` run later in the same writeTransaction, after the user fn
   *  returns and before commit. The tx must already have performed a
   *  write so the event has a pinned workspace and rolls back with the
   *  originating mutation. */
  emitEvent<P extends string>(name: P, payload: SameTxEventPayload<P>): void

  readonly meta: TxMeta
}

export interface RepoTxOptions {
  scope: ChangeScope
  description?: string
  /** Undo-group token (issue #306). Txs sharing a `groupId` merge into
   *  one undo entry at record time and stamp `group_id` into
   *  `tx_context` / `row_events`. Minted by `repo.undoGroup` and
   *  injected by its facade — callers don't set this by hand. */
  groupId?: string
  /** This transaction is the app MEASURING ITSELF, not doing the user's work.
   *
   *  Kept out of `repo.metrics().excludingTelemetry`, so a feature that reports
   *  performance figures does not report its own bookkeeping as load. Set it on
   *  every transaction such a feature issues, including its cleanup passes;
   *  anything left unflagged is counted as the user's work, which is the
   *  direction that under-reports a problem rather than inventing one.
   *
   *  Orthogonal to `scope`: telemetry writes are still gated, still synced,
   *  still non-undoable or not on their own terms. This flag only decides which
   *  side of the metrics they land on.
   *
   *  Covers THIS transaction, not the cascade it may schedule: a post-commit
   *  processor opens its own tx with opts it constructs, and nothing propagates
   *  the flag into it. A feature whose writes trigger writing processors would
   *  see those counted as the user's work. */
  telemetry?: boolean

  /** Skip recording an undo entry for this tx, without changing its scope.
   *
   *  For writes the program makes on the user's behalf while they are doing
   *  something else — a one-shot `WorkspaceBackfill` firing seconds after
   *  workspace open is the motivating case. Such a batch is a document edit in
   *  every other respect (it must stay read-only-gated and seed-guarded, so it
   *  keeps `BlockDefault`), but putting it on the undo stack means a cmd-Z
   *  aimed at the user's own edit silently reverts the whole pass — and with
   *  the pass's completion marker already recorded, permanently.
   *
   *  Prefer a non-undoable SCOPE when the write genuinely is not a document
   *  edit (`UiState`, `UserPrefs`, `Automation`). This flag exists for the case
   *  where the scope must stay `BlockDefault` for gating reasons but the entry
   *  would be a trap. Default false (entries are recorded as usual). */
  skipUndo?: boolean
}
