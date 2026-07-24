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
   *  `is_field_form`, and ONLY those — without advancing `updated_at`. This
   *  is the write mode for `core.deriveReferenceTarget`'s same-tx amendment:
   *  both columns are per-device reflections of `content` (never in
   *  `BLOCK_UPLOAD_COLUMNS`, never uploaded), so re-deriving them is not a
   *  synced edit and must not mint an upload PATCH. Because the UPDATE
   *  touches no upload column and leaves `updated_at` untouched,
   *  `blocks_upload_update`'s diff predicate stays false and nothing is
   *  enqueued — whereas `update(..., {skipMetadata})` still bumps
   *  `updated_at` (an upload column) and ships a redundant PATCH (PR #288
   *  §5, Decision A). Same-tab reactivity still fires (the write records a
   *  `referenceTargetId`/`isFieldForm`-changed snapshot); cross-tab rides
   *  the accompanying content edit's row_event. No-op when both columns
   *  already match. Not for content-bundled retargets — those change a
   *  synced column and go through `update`, which correctly uploads. */
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

  /** The one properties-as-blocks predicate (PR #288 §6): is `workspaceId`
   *  flipped to child-backed properties (`workspaces.properties_migration`
   *  at or past 'children' — never an equality test)? Shared by
   *  recognition, the dual-write, and the projection processors; cached
   *  per tx. Reads the local synced `workspaces` row; a missing row/column
   *  reads as un-flipped ('cell'). */
  isPropertyChildBackedWorkspace(workspaceId: string): Promise<boolean>

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
   *  recognized property field rows in a child-backed workspace (PR #288
   *  §9) — is opt-IN via `{hidePropertyChildren: true}`. In an un-flipped
   *  workspace nothing is recognized, so `hidePropertyChildren` is a no-op
   *  (dormant).
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
}
