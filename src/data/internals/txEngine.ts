/**
 * Tx engine — implements the public `Tx` interface (`src/data/api/tx.ts`)
 * over a PowerSync `writeTransaction` callback context. Spec §5.3, §10.
 *
 * Write-through to SQL: every primitive runs INSERT / UPDATE inline
 * against the writeTransaction's lock context. Triggers fire per
 * primitive (row_events written, upload routing decided). The engine
 * captures `(before, after)` per id in a tx-private snapshots map for
 * commit-walk handle diffing + undo recording. The shared cache is NOT
 * mutated mid-tx (v4.24) — outside-tx readers see only committed state.
 *
 * Reads:
 *   - `tx.get` / `tx.childrenOf` / `tx.parentOf` — SQL via the
 *     writeTransaction (read-your-own-writes natively).
 *   - `tx.peek` — sync; snapshots map first (own writes), then the
 *     pre-tx cache; never reads SQL.
 *
 * What lives here:  primitives, cycle check, single-workspace pin,
 * snapshots capture, codec at the four boundary sites.
 *
 * What lives in `commitPipeline.ts`:  the writeTransaction shell,
 * tx_context set/clear, command_events insert, post-commit cache walk,
 * undo recording, afterCommit dispatch.
 */

import type {
  AnyMutator,
  AnyPostCommitProcessor,
  BlockData,
  BlockDataPatch,
  ChangeScope,
  Mutator,
  NewBlockData,
  PropertySchema,
  Tx,
  TxMeta,
  TxSource,
  TxWriteOpts,
  User,
} from '@/data/api'
import {
  BlockNotFoundError,
  CycleError,
  DeletedConflictError,
  DeterministicIdCrossWorkspaceError,
  DuplicateIdError,
  MutatorNotRegisteredError,
  NotDeletedError,
  ProcessorNotRegisteredError,
  WorkspaceMismatchError,
  WorkspaceNotPinnedError,
} from '@/data/api'
import {
  BLOCK_STORAGE_COLUMNS,
  blockToRowParams,
  parseBlockRow,
  type BlockRow,
} from '@/data/blockSchema'
import { recordWrite, type SnapshotsMap, peekSnapshot } from './txSnapshots'
import { IS_DESCENDANT_OF_SQL } from './treeQueries'
import type { BlockCache } from '@/data/blockCache'

/** Minimal subset of `@powersync/common`'s `LockContext` we actually use.
 *  Production passes the real type; the test harness's
 *  `writeTransaction` callback exposes the same shape. */
export interface TxDb {
  execute(sql: string, params?: unknown[]): Promise<unknown>
  getAll<T>(sql: string, params?: unknown[]): Promise<T[]>
  getOptional<T>(sql: string, params?: unknown[]): Promise<T | null>
  get<T>(sql: string, params?: unknown[]): Promise<T>
}

/** Per-tx scheduling record produced by `tx.afterCommit`. The commit
 *  pipeline picks these up post-commit; rollback discards them. */
export interface AfterCommitJob {
  processorName: string
  args: unknown
  delayMs?: number
  /** Validation done at enqueue (per spec §5.7). Pre-validated args
   *  saved here so the dispatcher doesn't have to re-parse. */
}

/** A single mutator call captured during the tx — pushed by `tx.run`
 *  (spec §4.4 / §13.3). Written into `command_events.mutator_calls`
 *  as JSON at commit time so audit and undo can see what each tx did
 *  in mutator-grain terms, not just the row-grain row_events log. */
export interface MutatorCallRecord {
  name: string
  args: unknown
}

/** Construction context for `TxImpl`. The pipeline assembles this and
 *  hands it off; primitives use the fields directly. */
export interface TxImplContext {
  txDb: TxDb
  snapshots: SnapshotsMap
  cache: BlockCache
  meta: TxMeta
  afterCommitJobs: AfterCommitJob[]
  /** Mutable list of mutator calls captured during the tx. Pushed by
   *  `tx.run`; the pipeline pre-populates with the outermost call from
   *  `repo.mutate.X` / `repo.run`. JSON-serialized into
   *  `command_events.mutator_calls` at commit time. */
  mutatorCalls: MutatorCallRecord[]
  /** Now provider — injected for testability (deterministic timestamps). */
  now: () => number
  /** Mutator registry snapshot (taken at tx start). For stage 1.3 the
   *  registry is empty in v1; tx.run with an unregistered mutator
   *  throws MutatorNotRegisteredError. */
  mutators: ReadonlyMap<string, AnyMutator>
  /** Processor registry snapshot (taken at tx start). Used by
   *  `tx.afterCommit` to validate `scheduledArgs` against the
   *  processor's `scheduledArgsSchema` at enqueue time so a bad arg
   *  fails the originating tx (clean rollback) instead of failing
   *  later at fire time. */
  processors: ReadonlyMap<string, AnyPostCommitProcessor>
  /** UUID generator — injected for testability. */
  newId: () => string
}

const COLUMN_NAMES = BLOCK_STORAGE_COLUMNS.map(c => c.name)
const COLUMN_LIST = COLUMN_NAMES.join(', ')
const COLUMN_PLACEHOLDERS = COLUMN_NAMES.map(() => '?').join(', ')

const SELECT_BY_ID_SQL = `SELECT ${COLUMN_LIST} FROM blocks WHERE id = ?`
const SELECT_CHILDREN_SQL =
  `SELECT ${COLUMN_LIST} FROM blocks WHERE parent_id = ? AND deleted = 0 ORDER BY order_key, id`
/** Root-level siblings (parent_id IS NULL). When a tx has pinned a
 *  workspace, scope to that workspace so `tx.childrenOf(null)` doesn't
 *  spill across workspaces — important for single-workspace-per-tx
 *  invariants and for sibling-position helpers like createSiblingAbove
 *  on root blocks. */
const SELECT_ROOT_SIBLINGS_SQL =
  `SELECT ${COLUMN_LIST} FROM blocks WHERE parent_id IS NULL AND deleted = 0 AND workspace_id = ? ORDER BY order_key, id`
const SELECT_PARENT_SQL =
  `SELECT p.* FROM blocks AS c JOIN blocks AS p ON p.id = c.parent_id WHERE c.id = ? AND p.deleted = 0`
const INSERT_SQL = `INSERT INTO blocks (${COLUMN_LIST}) VALUES (${COLUMN_PLACEHOLDERS})`

export class TxImpl implements Tx {
  readonly meta: TxMeta

  private readonly ctx: TxImplContext

  /** True once `meta.workspaceId` has been pinned by the first write
   *  (or first write candidate that the engine validated to insert). */
  private workspacePinned = false

  constructor(ctx: TxImplContext) {
    this.ctx = ctx
    this.meta = ctx.meta
    if (ctx.meta.workspaceId !== null) {
      this.workspacePinned = true
    }
  }

  // ──── Reads ────

  async get(id: string): Promise<BlockData | null> {
    const row = await this.ctx.txDb.getOptional<BlockRow>(SELECT_BY_ID_SQL, [id])
    return row === null ? null : parseBlockRow(row)
  }

  peek(id: string): BlockData | null {
    const own = peekSnapshot(this.ctx.snapshots, id)
    if (own !== undefined) return own
    return this.ctx.cache.getSnapshot(id) ?? null
  }

  // ──── Lifecycle ────

  async create(data: NewBlockData, opts?: TxWriteOpts): Promise<string> {
    this.checkWorkspace(data.workspaceId)
    const id = data.id ?? this.ctx.newId()
    const row = this.buildNewBlockRow(id, data, opts)
    try {
      await this.ctx.txDb.execute(INSERT_SQL, blockToRowParams(row))
    } catch (e) {
      if (isUniqueConstraint(e, 'blocks.id')) throw new DuplicateIdError(id)
      throw e
    }
    this.pinWorkspace(data.workspaceId)
    recordWrite(this.ctx.snapshots, id, null, row)
    return id
  }

  async createOrGet(
    data: NewBlockData & { id: string },
    opts?: TxWriteOpts,
  ): Promise<{ id: string; inserted: boolean }> {
    this.checkWorkspace(data.workspaceId)
    const existing = await this.ctx.txDb.getOptional<BlockRow>(SELECT_BY_ID_SQL, [data.id])

    if (existing === null) {
      const row = this.buildNewBlockRow(data.id, data, opts)
      await this.ctx.txDb.execute(INSERT_SQL, blockToRowParams(row))
      this.pinWorkspace(data.workspaceId)
      recordWrite(this.ctx.snapshots, data.id, null, row)
      return {id: data.id, inserted: true}
    }

    if (existing.workspace_id !== data.workspaceId) {
      throw new DeterministicIdCrossWorkspaceError(
        data.id,
        existing.workspace_id,
        data.workspaceId,
      )
    }

    if (existing.deleted === 1) {
      throw new DeletedConflictError(data.id)
    }

    // Live-row hit. No write, no snapshot, no cache mutation, **and no
    // workspace pin** — the spec says `meta.workspaceId` is read from
    // the first WRITE's row (§5.3), and `tx.afterCommit` requires that
    // pin (§5.3 / §5.7). A live-hit alone is not a write: no row_events
    // are emitted, no command_events row claims this workspace. Pinning
    // here would let `tx.afterCommit` fire after a tx whose only effect
    // was a deterministic-id cache lookup, leaving CommittedEvent's
    // `workspaceId: string` contract honest only by accident. We did
    // already validate the live row's workspace_id matches `data.workspaceId`
    // above (cross-workspace throw); that's the defensive check, not a pin.
    return {id: data.id, inserted: false}
  }

  async delete(id: string): Promise<void> {
    const before = await this.requireExisting(id)
    this.checkWorkspace(before.workspaceId)
    if (before.deleted) return  // already a tombstone — no-op, no second snapshot
    const after: BlockData = {
      ...before,
      deleted: true,
      ...this.metadataPatch(false),
    }
    await this.ctx.txDb.execute(
      `UPDATE blocks SET deleted = 1, updated_at = ?, updated_by = ? WHERE id = ?`,
      [after.updatedAt, after.updatedBy, id],
    )
    this.pinWorkspace(before.workspaceId)
    recordWrite(this.ctx.snapshots, id, before, after)
  }

  async restore(id: string, patch?: BlockDataPatch, opts?: TxWriteOpts): Promise<void> {
    const before = await this.ctx.txDb.getOptional<BlockRow>(SELECT_BY_ID_SQL, [id])
    if (before === null) throw new BlockNotFoundError(id)
    if (before.deleted === 0) throw new NotDeletedError(id)
    const beforeData = parseBlockRow(before)
    this.checkWorkspace(beforeData.workspaceId)
    const after: BlockData = {
      ...beforeData,
      deleted: false,
      ...(patch?.content !== undefined ? {content: patch.content} : {}),
      ...(patch?.references !== undefined ? {references: patch.references} : {}),
      ...(patch?.properties !== undefined ? {properties: patch.properties} : {}),
      ...this.metadataPatch(opts?.skipMetadata),
    }
    await this.ctx.txDb.execute(
      `UPDATE blocks SET deleted = 0, content = ?, references_json = ?, properties_json = ?, updated_at = ?, updated_by = ? WHERE id = ?`,
      [
        after.content,
        JSON.stringify(after.references),
        JSON.stringify(after.properties),
        after.updatedAt,
        after.updatedBy,
        id,
      ],
    )
    this.pinWorkspace(beforeData.workspaceId)
    recordWrite(this.ctx.snapshots, id, beforeData, after)
  }

  // ──── Data-field updates ────

  async update(id: string, patch: BlockDataPatch, opts?: TxWriteOpts): Promise<void> {
    const before = await this.requireExisting(id)
    this.checkWorkspace(before.workspaceId)
    const after: BlockData = {
      ...before,
      ...(patch.content !== undefined ? {content: patch.content} : {}),
      ...(patch.references !== undefined ? {references: patch.references} : {}),
      ...(patch.properties !== undefined ? {properties: patch.properties} : {}),
      ...this.metadataPatch(opts?.skipMetadata),
    }
    await this.ctx.txDb.execute(
      `UPDATE blocks SET content = ?, references_json = ?, properties_json = ?, updated_at = ?, updated_by = ? WHERE id = ?`,
      [
        after.content,
        JSON.stringify(after.references),
        JSON.stringify(after.properties),
        after.updatedAt,
        after.updatedBy,
        id,
      ],
    )
    this.pinWorkspace(before.workspaceId)
    recordWrite(this.ctx.snapshots, id, before, after)
  }

  // ──── Tree moves ────

  async move(
    id: string,
    target: { parentId: string | null; orderKey: string },
    opts?: TxWriteOpts,
  ): Promise<void> {
    const before = await this.requireExisting(id)
    this.checkWorkspace(before.workspaceId)

    // §4.7 Layer 1: only engine-enforced check on parent_id mutation.
    // FK and triggers can't structurally catch cycles, so this is
    // load-bearing. Skipped when the target parent is null (re-rooting
    // can't introduce a cycle) or unchanged.
    if (
      target.parentId !== null &&
      target.parentId !== before.parentId &&
      target.parentId !== id
    ) {
      const hit = await this.ctx.txDb.getOptional<{hit: number}>(
        IS_DESCENDANT_OF_SQL,
        [target.parentId, id],
      )
      if (hit !== null) throw new CycleError(id, target.parentId)
    } else if (target.parentId === id) {
      throw new CycleError(id, id)
    }

    const after: BlockData = {
      ...before,
      parentId: target.parentId,
      orderKey: target.orderKey,
      ...this.metadataPatch(opts?.skipMetadata),
    }
    await this.ctx.txDb.execute(
      `UPDATE blocks SET parent_id = ?, order_key = ?, updated_at = ?, updated_by = ? WHERE id = ?`,
      [target.parentId, target.orderKey, after.updatedAt, after.updatedBy, id],
    )
    this.pinWorkspace(before.workspaceId)
    recordWrite(this.ctx.snapshots, id, before, after)
  }

  // ──── Typed property primitives — the codec boundary sites ────

  async setProperty<T>(
    id: string,
    schema: PropertySchema<T>,
    value: T,
    opts?: TxWriteOpts,
  ): Promise<void> {
    const before = await this.requireExisting(id)
    this.checkWorkspace(before.workspaceId)
    const encoded = schema.codec.encode(value)
    const properties = {...before.properties, [schema.name]: encoded}
    const after: BlockData = {
      ...before,
      properties,
      ...this.metadataPatch(opts?.skipMetadata),
    }
    await this.ctx.txDb.execute(
      `UPDATE blocks SET properties_json = ?, updated_at = ?, updated_by = ? WHERE id = ?`,
      [JSON.stringify(properties), after.updatedAt, after.updatedBy, id],
    )
    this.pinWorkspace(before.workspaceId)
    recordWrite(this.ctx.snapshots, id, before, after)
  }

  async getProperty<T>(id: string, schema: PropertySchema<T>): Promise<T> {
    const row = await this.ctx.txDb.getOptional<BlockRow>(SELECT_BY_ID_SQL, [id])
    if (row === null) throw new BlockNotFoundError(id)
    const data = parseBlockRow(row)
    const stored = data.properties[schema.name]
    if (stored === undefined) return schema.defaultValue
    return schema.codec.decode(stored)
  }

  // ──── Composition ────

  async run<Args, R>(mutator: Mutator<Args, R>, args: Args): Promise<R> {
    const registered = this.ctx.mutators.get(mutator.name)
    if (registered === undefined) throw new MutatorNotRegisteredError(mutator.name)
    // Sub-mutator scope must equal tx scope (spec §10.2). Resolve the
    // sub's scope from args (it may be a function form).
    const subScope: ChangeScope =
      typeof registered.scope === 'function'
        ? registered.scope(args as never)
        : registered.scope
    if (subScope !== this.meta.scope) {
      throw new Error(
        `tx.run scope mismatch: tx is "${this.meta.scope}", mutator "${mutator.name}" requires "${subScope}"`,
      )
    }
    // Record the call BEFORE running so even a throwing mutator's
    // call appears in command_events.mutator_calls — the pipeline
    // discards mutatorCalls on rollback alongside snapshots/afterCommit
    // jobs, so this is only audited on commit anyway.
    this.ctx.mutatorCalls.push({name: mutator.name, args})
    // Execute against the same Tx — sub-mutator's writes go through
    // immediately and are visible to subsequent reads via SQL.
    return await registered.apply(this, args as never) as R
  }

  // ──── Within-tx tree primitives ────

  async childrenOf(parentId: string | null, workspaceId?: string): Promise<BlockData[]> {
    if (parentId === null) {
      // SQL `parent_id = NULL` never matches; use `IS NULL`. Scope to
      // a workspace by one of: explicit arg → pinned meta → throw.
      // Cross-workspace root listings would let kernel-mutator
      // sibling-position helpers compute order against rows from
      // another workspace (and `move({parentId: null, position:
      // {before, siblingId}})` could even target a different
      // workspace's sibling) — never safe, so we refuse rather than
      // fall back to "all roots." Callers that read a sibling/parent
      // first know the right workspace and pass it explicitly; the
      // pinned-meta fallback covers post-first-write callers.
      const ws = workspaceId ?? (this.workspacePinned ? this.meta.workspaceId : null)
      if (ws === null) {
        throw new WorkspaceNotPinnedError()
      }
      const rows = await this.ctx.txDb.getAll<BlockRow>(SELECT_ROOT_SIBLINGS_SQL, [ws])
      return rows.map(parseBlockRow)
    }
    const rows = await this.ctx.txDb.getAll<BlockRow>(SELECT_CHILDREN_SQL, [parentId])
    return rows.map(parseBlockRow)
  }

  async parentOf(childId: string): Promise<BlockData | null> {
    const row = await this.ctx.txDb.getOptional<BlockRow>(SELECT_PARENT_SQL, [childId])
    return row === null ? null : parseBlockRow(row)
  }

  // ──── Post-commit scheduling ────

  afterCommit<P extends string>(
    processorName: P,
    args: unknown,
    options?: { delayMs?: number },
  ): void {
    if (!this.workspacePinned) throw new WorkspaceNotPinnedError()
    // Validate the target at enqueue time (spec §5.7). Failures here
    // propagate out of the user fn into the writeTransaction's rollback,
    // surfacing the bug to the caller cleanly. Three checks:
    //   1. processor must be registered (typo / stale plugin → throw)
    //   2. processor must be explicit-watching (field-watch processors
    //      don't take scheduledArgs and can't be scheduled)
    //   3. scheduledArgs must parse against the processor's schema
    // Skipping these and warning at dispatch time would silently lose
    // the work after the originating tx had already committed.
    const processor = this.ctx.processors.get(processorName)
    if (processor === undefined) {
      throw new ProcessorNotRegisteredError(processorName)
    }
    if (processor.watches.kind !== 'explicit') {
      throw new Error(
        `tx.afterCommit("${processorName}") — processor watches.kind = "${processor.watches.kind}"; only "explicit" processors accept scheduled jobs`,
      )
    }
    // .parse throws on shape mismatch — propagates as above.
    // TypeScript can't narrow the discriminated union through the
    // `AnyPostCommitProcessor = PostCommitProcessor<any>` alias
    // because `any` collapses the discriminator; the runtime check
    // above is the actual guard.
    const schema = (processor as {scheduledArgsSchema: {parse: (x: unknown) => unknown}}).scheduledArgsSchema
    const validatedArgs = schema.parse(args)
    this.ctx.afterCommitJobs.push({
      processorName,
      args: validatedArgs,
      delayMs: options?.delayMs,
    })
  }

  // ──── Engine-internal raw row applier (UndoManager only) ────

  /** Drive the row at `id` to exactly `target` (or soft-delete if target
   *  is null). Bypasses the public primitives — intentionally — because
   *  undo replay restores arbitrary snapshot state that the narrow patch
   *  shape of `tx.update` can't express (e.g. `parent_id` + `order_key`
   *  + `deleted` flipping in one write). Spec §10 step 7 + the
   *  BlockDataPatch comment in `api/blockData.ts`.
   *
   *  Cycle / parent-deleted UX checks are skipped: the snapshot was
   *  captured from a previously-committed tx, so the target state is
   *  known to be valid (the engine validated it then). The
   *  workspace-invariant trigger still fires on UPDATE-of-parent_id, so
   *  the storage-level guarantee holds. `updatedAt` / `updatedBy` are
   *  stamped to the replay tx's user + now() — a redo at 10:01 by user
   *  B is correctly attributed to B@10:01, not the original write.
   *
   *  Captures `(currentRow, applied)` into the snapshots map so the
   *  pipeline's commit-walk updates the cache and fires handles for the
   *  rolled-back row. */
  async applyRaw(id: string, target: BlockData | null): Promise<void> {
    const beforeRow = await this.ctx.txDb.getOptional<BlockRow>(SELECT_BY_ID_SQL, [id])
    const beforeData = beforeRow === null ? null : parseBlockRow(beforeRow)
    const now = this.ctx.now()
    const userId = this.meta.user.id

    if (target === null) {
      // Inverse of a `create`: original tx wrote a new row; undo
      // soft-deletes it. If the row vanished out from under us (v1
      // doesn't hard-delete, so this is mostly defensive) or was
      // already tombstoned, nothing to do.
      if (beforeData === null || beforeData.deleted) return
      const after: BlockData = {
        ...beforeData,
        deleted: true,
        updatedAt: now,
        updatedBy: userId,
      }
      await this.ctx.txDb.execute(
        `UPDATE blocks SET deleted = 1, updated_at = ?, updated_by = ? WHERE id = ?`,
        [now, userId, id],
      )
      this.pinWorkspace(beforeData.workspaceId)
      recordWrite(this.ctx.snapshots, id, beforeData, after)
      return
    }

    if (beforeData === null) {
      // Row missing — re-INSERT to restore it. v1 has no hard-delete
      // primitive, so reaching here means the row was purged through
      // some non-tx path; we still try to restore. Engine fields
      // (createdAt/createdBy/updatedAt/updatedBy) come from the
      // captured target.
      const inserted: BlockData = {
        ...target,
        updatedAt: now,
        updatedBy: userId,
      }
      await this.ctx.txDb.execute(INSERT_SQL, blockToRowParams(inserted))
      this.pinWorkspace(target.workspaceId)
      recordWrite(this.ctx.snapshots, id, null, inserted)
      return
    }

    // Row exists; UPDATE all non-immutable fields to match target.
    // workspace_id, id, created_at, created_by are immutable by
    // contract (§4.1.1) and the snapshot's values for these match
    // the row's current values when the original tx pre-existed the
    // row. updated_at / updated_by stamp the replay action.
    const after: BlockData = {
      ...target,
      updatedAt: now,
      updatedBy: userId,
    }
    await this.ctx.txDb.execute(
      `UPDATE blocks SET parent_id = ?, order_key = ?, content = ?, properties_json = ?, references_json = ?, deleted = ?, updated_at = ?, updated_by = ? WHERE id = ?`,
      [
        target.parentId,
        target.orderKey,
        target.content,
        JSON.stringify(target.properties),
        JSON.stringify(target.references),
        target.deleted ? 1 : 0,
        now,
        userId,
        id,
      ],
    )
    this.pinWorkspace(beforeData.workspaceId)
    recordWrite(this.ctx.snapshots, id, beforeData, after)
  }

  // ──── Internal helpers ────

  /** Validate that a write to `workspaceId` is allowed in this tx.
   *  Pre-pin (no writes yet) anything goes. Post-pin, must match. */
  private checkWorkspace(workspaceId: string): void {
    if (this.workspacePinned && this.meta.workspaceId !== workspaceId) {
      throw new WorkspaceMismatchError(this.meta.workspaceId!, workspaceId)
    }
  }

  /** Pin the tx's workspace_id from the first successful primitive.
   *  Idempotent. Mutates `this.meta` so external readers see the pin. */
  private pinWorkspace(workspaceId: string): void {
    if (this.workspacePinned) return
    ;(this.meta as { workspaceId: string }).workspaceId = workspaceId
    this.workspacePinned = true
  }

  private metadataPatch(skipMetadata?: boolean): {
    updatedAt: number
    updatedBy: string
  } | Record<string, never> {
    if (skipMetadata) return {}
    return {updatedAt: this.ctx.now(), updatedBy: this.meta.user.id}
  }

  /** Build a fresh BlockData for `tx.create` / `tx.createOrGet` insert
   *  paths. Engine sets all four metadata columns from tx_context unless
   *  `opts.skipMetadata` (used only by bookkeeping writes). */
  private buildNewBlockRow(
    id: string,
    data: NewBlockData,
    opts: TxWriteOpts | undefined,
  ): BlockData {
    const now = this.ctx.now()
    const userId = this.meta.user.id
    const ts = opts?.skipMetadata ? 0 : now
    const by = opts?.skipMetadata ? '' : userId
    return {
      id,
      workspaceId: data.workspaceId,
      parentId: data.parentId,
      orderKey: data.orderKey,
      content: data.content ?? '',
      properties: data.properties ?? {},
      references: data.references ?? [],
      createdAt: ts,
      updatedAt: ts,
      createdBy: by,
      updatedBy: by,
      deleted: false,
    }
  }

  private async requireExisting(id: string): Promise<BlockData> {
    const row = await this.ctx.txDb.getOptional<BlockRow>(SELECT_BY_ID_SQL, [id])
    if (row === null) throw new BlockNotFoundError(id)
    return parseBlockRow(row)
  }
}

/** Detect SQLite UNIQUE-constraint failures on `blocks.id`. SQLite's
 *  error messages embed the column name, so a string-match is the
 *  reliable signal in practice. The shape `'UNIQUE constraint failed:
 *  blocks.id'` covers the SQLite C error and the better-sqlite3 wrapper
 *  thereof. */
const isUniqueConstraint = (e: unknown, columnFqn: string): boolean => {
  if (e === null || typeof e !== 'object') return false
  const msg = (e as {message?: unknown}).message
  return typeof msg === 'string' && msg.includes(`UNIQUE constraint failed: ${columnFqn}`)
}

/** Build the initial `meta` for a tx — used by the pipeline at the
 *  start of `repo.tx`. The workspaceId starts null; the first write
 *  primitive pins it. */
export const newTxMeta = (params: {
  txId: string
  scope: ChangeScope
  source: TxSource
  user: User
  description?: string
}): TxMeta => ({
  txId: params.txId,
  scope: params.scope,
  source: params.source,
  user: params.user,
  description: params.description,
  workspaceId: null,
})
