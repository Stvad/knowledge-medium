import type {
  BlockData,
  BlockDataPatch,
  NewBlockData,
} from './blockData'
import type { ChangeScope, TxSource } from './changeScope'
import type { PropertySchema } from './propertySchema'
import type { User } from './user'

/** Per-write opt: skip the engine's automatic `updatedAt`/`updatedBy` bump
 *  (and `createdAt`/`createdBy` on `tx.create`). Used by bookkeeping writes
 *  whose state isn't user intent — e.g. parseReferences updating
 *  `references`. User-facing mutators should not set this. */
export interface TxWriteOpts {
  skipMetadata?: boolean
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

/** Forward declarations — these come from `mutator.ts` / `processor.ts`
 *  but are referenced by the Tx interface. */
import type { Mutator } from './mutator'
import type { ScheduledArgsFor } from './processor'

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
   *  Parent existence + same-workspace come from the storage layer
   *  (translated to `ParentNotFoundError` / `ParentWorkspaceMismatchError`);
   *  soft-deleted-parent is a kernel-mutator UX rule and does NOT fire
   *  on raw `tx.create` — see §4.7 Layer 1 (v4.30). */
  create(data: NewBlockData, opts?: TxWriteOpts): Promise<string>

  /** Insert OR fetch the live row at a deterministic id. **No tombstone
   *  resurrection in the primitive** — see §10.4. Throws
   *  `DeterministicIdCrossWorkspaceError` if the existing row is in a
   *  different workspace; throws `DeletedConflictError` if the existing
   *  row is soft-deleted. The shared `createOrRestoreTargetBlock` helper
   *  (§7, §13.1) catches `DeletedConflictError` and runs `tx.restore`. */
  createOrGet(
    data: NewBlockData & { id: string },
    opts?: TxWriteOpts,
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

  /** Update non-structural data fields only (`content` / `references` /
   *  `properties`). Structural mutations have their own primitives. The
   *  patch type excludes `parentId`, `orderKey`, `workspaceId`, `deleted`,
   *  and metadata fields at the type level. */
  update(id: string, patch: BlockDataPatch, opts?: TxWriteOpts): Promise<void>

  // ──── Tree moves (structural) ────

  /** Move a row to a new `(parentId, orderKey)`. Engine runs
   *  `isDescendantOf(target.parentId, id)` and throws `CycleError` if the
   *  new parent would be a descendant of `id` — load-bearing because FK
   *  and triggers can't structurally catch cycles. `target.parentId = null`
   *  re-roots the row (workspace root). */
  move(
    id: string,
    target: { parentId: string | null; orderKey: string },
    opts?: TxWriteOpts,
  ): Promise<void>

  // ──── Typed property primitives ────

  /** `setProperty`: applies `codec.encode`, merges into the row's
   *  `properties` map, and writes through immediately. Bypassing codecs
   *  (raw `properties` writes) goes through `tx.update`. */
  setProperty<T>(
    id: string,
    schema: PropertySchema<T>,
    value: T,
    opts?: TxWriteOpts,
  ): Promise<void>

  /** `getProperty`: reads SQL/cache and applies `codec.decode`. Returns
   *  the schema's `defaultValue` if the property is absent. */
  getProperty<T>(id: string, schema: PropertySchema<T>): Promise<T>

  // ──── Composition ────

  /** Compose another mutator. Sub-mutator's writes go through immediately;
   *  the parent's subsequent reads see them via SQL (read-your-own-writes
   *  inside the writeTransaction). No overlay arithmetic. */
  run<Args, R>(mutator: Mutator<Args, R>, args: Args): Promise<R>

  // ──── Within-tx tree primitives ────

  /** Children of `parentId`, ordered `(order_key, id)`, filtered
   *  `deleted = 0`. Reads SQL via the writeTransaction.
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
  childrenOf(parentId: string | null, workspaceId?: string): Promise<BlockData[]>

  /** Parent of `childId`, or null if `childId` has no parent or doesn't
   *  exist. Reads SQL via the writeTransaction. */
  parentOf(childId: string): Promise<BlockData | null>

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

  readonly meta: TxMeta
}

export interface RepoTxOptions {
  scope: ChangeScope
  description?: string
}
