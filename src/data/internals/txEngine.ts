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
  AnyPropertyAssignment,
  AnyPropertySchema,
  BlockData,
  BlockDataPatch,
  Mutator,
  NewBlockData,
  PropertySchema,
  SameTxEmittedEvent,
  SameTxEventPayload,
  SiblingAnchor,
  SiblingDirection,
  Tx,
  TxInsertOpts,
  TxMeta,
  TxSource,
  TxWriteOpts,
  User,
} from '@/data/api'
import {
  BlockNotFoundError,
  ChangeScope,
  CycleError,
  DeletedConflictError,
  DeterministicIdCrossWorkspaceError,
  DuplicateIdError,
  MutatorNotRegisteredError,
  NotDeletedError,
  ParentDeletedError,
  ParentNotFoundError,
  ParentWorkspaceMismatchError,
  ProcessorNotRegisteredError,
  PropertySchemaScopeMismatchError,
  SeededDefinitionWriteError,
  WorkspaceMismatchError,
  WorkspaceNotPinnedError,
  normalizeReferences,
  scopePoliciesEquivalent,
} from '@/data/api'
import { isValidSeededDefinition } from '@/data/definitionSeeds'
import {
  BLOCKS_TABLE_COLUMN_NAMES,
  blockToRowParams,
  parseBlockRow,
  type BlockRow,
} from '@/data/blockSchema'
import { recordWrite, type SnapshotsMap, peekSnapshot } from './txSnapshots'
import { IS_DESCENDANT_OF_SQL } from './treeQueries'
import { SELECT_BLOCK_BY_ALIAS_IN_WORKSPACE_SQL } from './kernelQueries'
import { jsonValuesEqual } from './jsonCanonical'
import type { BlockCache } from '@/data/blockCache'
import {
  isResolvedPropertySchema,
  requireWritablePropertySchema,
  type PropertySchemaResolver,
} from './propertySchemaResolution'
import { readIsChildBackedWorkspace } from '@/data/workspaceSchema'
import { parseExactReferenceBlockContent } from '@/data/referenceBlock'
import { keyAtStart } from '@/data/orderKey'
import {
  isInsidePropertySubtreeWalk,
  isPropertyFieldInstance,
  propertyFieldContent,
  propertyValueToChildContent,
  type IsPropertyFieldDefinition,
} from '@/data/propertyChildren'
import { collapseDuplicateValueChild } from './propertyChildrenProcessor'
import { deleteSubtreeInTx } from '@/data/subtreeDelete'

/** Minimal subset of `@powersync/common`'s `LockContext` we actually use.
 *  Production passes the real type; the test harness's
 *  `writeTransaction` callback exposes the same shape. */
export interface TxDb {
  execute(sql: string, params?: unknown[]): Promise<unknown>
  getAll<T>(sql: string, params?: unknown[]): Promise<T[]>
  getOptional<T>(sql: string, params?: unknown[]): Promise<T | null>
  get<T>(sql: string, params?: unknown[]): Promise<T>
}

const updatePatchChangesBlock = (before: BlockData, patch: BlockDataPatch): boolean => {
  if (patch.content !== undefined && patch.content !== before.content) return true
  if (
    patch.referenceTargetId !== undefined &&
    patch.referenceTargetId !== (before.referenceTargetId ?? null)
  ) {
    return true
  }
  if (
    patch.isFieldForm !== undefined &&
    patch.isFieldForm !== (before.isFieldForm ?? false)
  ) {
    return true
  }
  if (
    patch.references !== undefined &&
    !jsonValuesEqual(before.references, normalizeReferences(patch.references))
  ) {
    return true
  }
  if (
    patch.properties !== undefined &&
    !jsonValuesEqual(before.properties, patch.properties)
  ) {
    return true
  }
  return false
}

/** v1 invariant (schema-unification §5.1): a materialized seed definition is
 *  wholly code-owned — its bag and lifecycle belong to materialization and
 *  the §13 revision-upgrade step (both `Automation` scope); synced-in
 *  changes never pass through this engine at all. The schema editor and
 *  property panel already render seed rows read-only; this is the
 *  data-layer backstop for the agent bridge, the importer, and the outline
 *  delete key.
 *
 *  ONE commit-time check over the tx's snapshots map — the single
 *  convergence point for everything a tx wrote — rather than per-primitive
 *  guards. The per-site form needed every current and future write path to
 *  remember a call and missed three: `create` (forge a provenance-valid row
 *  at the publicly computable uuidv5 id before materialization runs),
 *  `restore` with a properties patch, and `update` that makes an occupant
 *  row BECOME provenance-valid (per-site guards checked only the `before`
 *  row). Checking (before, after) pairs here covers both directions for
 *  every primitive at once.
 *
 *  Rules, under `BlockDefault` scope only:
 *   - a row may not BECOME a valid seeded definition (forgery);
 *   - a valid seeded definition's bag may not change (which also covers
 *     stripping its provenance) and it may not be tombstoned or
 *     hard-deleted. Content/references edits and plain restores stay
 *     allowed — they don't touch the code-owned fields, and
 *     materialization itself restores tombstones.
 *
 *  The check is on the tx's NET effect: `snapshots` holds one (before,
 *  after) pair per row — first-touch `before` vs last-write `after` — so
 *  an intermediate state within the tx is never path-checked. A row
 *  forged mid-tx and reverted before commit converges to a net no-op and
 *  passes, even though its row/crud events may transit through the
 *  forged state on the way there. Accepted: same-tx processors observe
 *  net diffs too, the committed state is unforged either way, and sync
 *  is out of this guard's threat model regardless. */
export const assertNoSeedDefinitionWrites = (
  snapshots: SnapshotsMap,
  scope: ChangeScope,
): void => {
  if (scope !== ChangeScope.BlockDefault) return
  for (const [id, {before, after}] of snapshots) {
    const beforeSeed = before !== null && isValidSeededDefinition(before)
    if (!beforeSeed && after !== null && isValidSeededDefinition(after)) {
      throw new SeededDefinitionWriteError(id)
    }
    if (beforeSeed && (
      after === null
      || !jsonValuesEqual(before.properties, after.properties)
      || (!before.deleted && after.deleted)
    )) {
      throw new SeededDefinitionWriteError(id)
    }
  }
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
  /** Mutable list of same-tx domain events emitted by tx primitives /
   *  mutators. Same-tx event processors consume this list before commit. */
  sameTxEvents: SameTxEmittedEvent[]
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
  /** Tx-start-captured resolver factory — mirrors the commit pipeline's own
   *  `resolverFor` closure (built from the same registry-factory /
   *  workspaceId / seed-name-counts triple) so both surfaces resolve
   *  property schemas against one registry snapshot per tx, without this
   *  context re-deriving that closure itself. */
  propertySchemaResolverFor: (workspaceId: string) => PropertySchemaResolver
  /** UUID generator — injected for testability. */
  newId: () => string
  /** Write observation hook for the commit pipeline's derivation re-run
   *  pass (issue #402): called once per recorded row write, from the same
   *  choke point as `recordWrite`, with THIS write's (before, after) pair
   *  — per-write granularity, unlike the snapshots map's net (tx-start,
   *  latest) pair. The pipeline uses it to maintain per-row write
   *  generations and the per-field settled-write baseline (which needs to
   *  know exactly which fields each individual write touched, so a
   *  settled amendment and a later unsettled write to the SAME row stay
   *  distinguishable). Absent in contexts that don't run the same-tx pass
   *  (tests constructing TxImpl directly). */
  onWrite?: (id: string, before: BlockData | null, after: BlockData | null) => void
}

// Live `blocks`-table column list: storage columns + local-only derived
// columns (`reference_target_id`). Everything this engine touches is the
// live table, never `blocks_synced`.
const COLUMN_NAMES = BLOCKS_TABLE_COLUMN_NAMES
const COLUMN_LIST = COLUMN_NAMES.join(', ')
const COLUMN_PLACEHOLDERS = COLUMN_NAMES.map(() => '?').join(', ')

const SELECT_BY_ID_SQL = `SELECT ${COLUMN_LIST} FROM blocks WHERE id = ?`
const SELECT_CHILDREN_SQL =
  `SELECT ${COLUMN_LIST} FROM blocks WHERE parent_id = ? AND deleted = 0 ORDER BY order_key, id`
const SELECT_PROPERTY_FIELD_CHILD_SQL =
  `SELECT ${COLUMN_LIST} FROM blocks
   WHERE workspace_id = ?
     AND parent_id = ?
     AND reference_target_id = ?
     AND deleted = 0
   ORDER BY order_key, id`
/** Existence probes for `tx.hasChildren`. The live-only form keeps the
 *  `deleted = 0` clause so it stays served by the partial
 *  `idx_blocks_parent_order`; the `includeDeleted` form drops it (and so
 *  cannot use that partial index — table scan), used only off hot paths
 *  to detect a row that ever had children vs a never-populated stub. */
const SELECT_HAS_CHILD_SQL =
  `SELECT 1 AS one FROM blocks WHERE parent_id = ? AND deleted = 0 LIMIT 1`
const SELECT_HAS_CHILD_INCLUDING_DELETED_SQL =
  `SELECT 1 AS one FROM blocks WHERE parent_id = ? LIMIT 1`
/** Root-level siblings (parent_id IS NULL). When a tx has pinned a
 *  workspace, scope to that workspace so `tx.childrenOf(null)` doesn't
 *  spill across workspaces — important for single-workspace-per-tx
 *  invariants and for sibling-position helpers like createSiblingAbove
 *  on root blocks. */
const SELECT_ROOT_SIBLINGS_SQL =
  `SELECT ${COLUMN_LIST} FROM blocks WHERE parent_id IS NULL AND deleted = 0 AND workspace_id = ? ORDER BY order_key, id`
const SELECT_NEXT_CHILD_SIBLING_SQL =
  `SELECT ${COLUMN_LIST} FROM blocks
   WHERE parent_id = ? AND deleted = 0
     AND (order_key > ? OR (order_key = ? AND id > ?))
   ORDER BY order_key, id
   LIMIT 1`
const SELECT_PREVIOUS_CHILD_SIBLING_SQL =
  `SELECT ${COLUMN_LIST} FROM blocks
   WHERE parent_id = ? AND deleted = 0
     AND (order_key < ? OR (order_key = ? AND id < ?))
   ORDER BY order_key DESC, id DESC
   LIMIT 1`
const SELECT_NEXT_ROOT_SIBLING_SQL =
  `SELECT ${COLUMN_LIST} FROM blocks
   WHERE parent_id IS NULL AND deleted = 0 AND workspace_id = ?
     AND (order_key > ? OR (order_key = ? AND id > ?))
   ORDER BY order_key, id
   LIMIT 1`
const SELECT_PREVIOUS_ROOT_SIBLING_SQL =
  `SELECT ${COLUMN_LIST} FROM blocks
   WHERE parent_id IS NULL AND deleted = 0 AND workspace_id = ?
     AND (order_key < ? OR (order_key = ? AND id < ?))
   ORDER BY order_key DESC, id DESC
   LIMIT 1`
const SELECT_PARENT_SQL =
  `SELECT p.* FROM blocks AS c JOIN blocks AS p ON p.id = c.parent_id WHERE c.id = ? AND p.deleted = 0`
const SELECT_PARENT_WORKSPACE_SQL =
  `SELECT workspace_id, deleted FROM blocks WHERE id = ?`
const INSERT_SQL = `INSERT INTO blocks (${COLUMN_LIST}) VALUES (${COLUMN_PLACEHOLDERS})`

export class TxImpl implements Tx {
  readonly meta: TxMeta

  private readonly ctx: TxImplContext

  /** True once `meta.workspaceId` has been pinned by the first write
   *  (or first write candidate that the engine validated to insert). */
  private workspacePinned = false

  /** Ids inserted in THIS tx via a `{systemMint: true}` create/createOrGet.
   *  Same-tx follow-up writes (`update` / `setProperty` / `move` / …) to one
   *  of these HOLD `updated_at` at the `0` pristine sentinel instead of
   *  advancing it — mirrors the upload compactor's same-tx CREATE+PATCH fusion
   *  (`createTxId`), so the multi-write shaping a deterministic-id mint does
   *  (content + alias prop + type marker) uploads as a single pristine default
   *  the reconcile gate lets yield. Per-tx (the engine builds a fresh TxImpl
   *  per `repo.tx`), so it never leaks across transactions. */
  private readonly systemMintedIds = new Set<string>()

  /** Per-tx cache of the properties-as-blocks flip predicate (PR #288 §6):
   *  workspaceId → `properties_migration` at or past 'children'. One
   *  `workspaces` read per workspace per tx; the column is synced-only
   *  (never written through this engine), so within-tx staleness cannot
   *  occur. */
  private readonly childBackedWorkspaceCache = new Map<string, boolean>()

  /** Per-tx memo for the §9 ancestry rule: block id → "its subtree position
   *  passes through a field row" (so its children are property values /
   *  comments, never field rows). */
  private readonly propertySubtreeCache = new Map<string, boolean>()

  constructor(ctx: TxImplContext) {
    this.ctx = ctx
    this.meta = ctx.meta
    if (ctx.meta.workspaceId !== null) {
      this.workspacePinned = true
    }
  }

  private propertySchemaResolverFor(workspaceId: string): PropertySchemaResolver {
    return this.ctx.propertySchemaResolverFor(workspaceId)
  }

  private resolvePropertySchemaForRow<T>(
    row: BlockData,
    schema: PropertySchema<T>,
  ): PropertySchema<T> {
    return requireWritablePropertySchema(
      schema,
      this.propertySchemaResolverFor(row.workspaceId),
    )
  }

  /** Scope-consistency guard shared by every property write primitive
   *  (`setProperty` / `unsetProperty` / `setProperties`). The tx was admitted
   *  under `this.meta.scope`, chosen from the CALLER's `schema.changeScope`. If
   *  the definition's change-scope was edited after the caller captured its
   *  schema, the resolved scope can differ — admitting the write under the
   *  stale scope would bypass the read-only gate and misroute its undo entry.
   *  Compare by POLICY (read-only behavior + undoability), not identity: a
   *  same-policy difference (e.g. the references processor writing a
   *  BlockDefault property under its own `References` bucket) is intentional
   *  and harmless, while a policy difference (a stale UiState schema writing a
   *  now-BlockDefault property) is exactly the bypass/misroute this guards. */
  private assertPropertyWriteScope(resolvedSchema: PropertySchema<unknown>): void {
    if (!scopePoliciesEquivalent(resolvedSchema.changeScope, this.meta.scope)) {
      throw new PropertySchemaScopeMismatchError(
        resolvedSchema.name, this.meta.scope, resolvedSchema.changeScope,
      )
    }
  }

  resolvePropertyFieldSchema(
    workspaceId: string,
    fieldId: string,
  ): AnyPropertySchema | null {
    const resolution = this.propertySchemaResolverFor(workspaceId).resolveField(fieldId)
    return resolution.status === 'resolved' ? resolution.schema : null
  }

  async isPropertyChildBackedWorkspace(workspaceId: string): Promise<boolean> {
    const cached = this.childBackedWorkspaceCache.get(workspaceId)
    if (cached !== undefined) return cached
    const flipped = await readIsChildBackedWorkspace(this.ctx.txDb, workspaceId)
    this.childBackedWorkspaceCache.set(workspaceId, flipped)
    return flipped
  }

  /** §9 recognition, fieldId half: does this id name a definition the
   *  workspace's registry can resolve? Shadowed losers COUNT — their field
   *  rows keep classifying (excluded only from the name map / projection). */
  private isFieldDefinitionCheckerFor(workspaceId: string): IsPropertyFieldDefinition {
    const resolver = this.propertySchemaResolverFor(workspaceId)
    return (fieldId) => {
      const resolution = resolver.resolveField(fieldId)
      return resolution.status === 'resolved'
        || (resolution.status === 'identity-unavailable' && resolution.reason === 'shadowed')
    }
  }

  /** Will `core.deriveReferenceTarget`'s stamp make this row a property
   *  field row at commit? Content-based twin of the stored-column
   *  recognition, for gates that run BEFORE the derive processor in the
   *  same tx (the setProperty dual-write, the materialize processor's
   *  mirror in propertyChildrenProcessor). Root rows are never field rows
   *  (§9 positional — a field row is a child of the owning block), so
   *  their bag writes must keep materializing normally. Direct-target
   *  check only — it deliberately doesn't re-walk ancestors' content. */
  private isProspectiveFieldRow(row: BlockData): boolean {
    if (row.parentId === null) return false
    // The id-carrying whole-block forms (`((id))`, `[label](((id)))`, marked
    // or not — §7) resolve textually, so this sync probe covers them
    // completely. A `[[name]]` whole-block ref needs the async alias lookup
    // this same-tx probe can't do — post-derive recognition
    // (`isPropertyFieldInstance`) covers those via the column.
    const exact = parseExactReferenceBlockContent(row.content)
    if (exact === null || exact.kind === 'alias') return false
    return this.isFieldDefinitionCheckerFor(row.workspaceId)(exact.id)
  }

  /** Record one row write's (before, after) into the tx snapshots — and keep
   *  the §9 ancestry memo from outliving the tree it describes.
   *
   *  EVERY primitive funnels through here rather than calling `recordWrite`
   *  directly, deliberately: `propertySubtreeCache` answers "does this chain
   *  pass through a field row", derived from exactly `parentId` +
   *  `referenceTargetId`, and BOTH change mid-tx — `move` re-parents,
   *  `core.deriveReferenceTarget` stamps, merge relocates. A per-site
   *  "remember to invalidate" would be one more thing to forget on the next
   *  primitive; one choke point can't be.
   *
   *  Clearing wholesale is the right grain: the walk memoizes EVERY id on the
   *  chain it walked, so one re-parent can flip the answer for a whole
   *  subtree, not just the moved row — there is no cheap "which entries did
   *  this invalidate". The memo only serves visible-view reads, so the cost of
   *  dropping it is a re-walk on the next such read, while a stale entry
   *  silently filters a row's values as machinery (or leaks machinery as
   *  values). */
  private record(id: string, before: BlockData | null, after: BlockData | null): void {
    if (
      (before?.parentId ?? null) !== (after?.parentId ?? null)
      || (before?.referenceTargetId ?? null) !== (after?.referenceTargetId ?? null)
    ) {
      this.propertySubtreeCache.clear()
    }
    recordWrite(this.ctx.snapshots, id, before, after)
    this.ctx.onWrite?.(id, before, after)
  }

  /** §9 ancestry rule: role is positional and inherits — everything beneath
   *  a field row is property-subtree interior (values, comments, ordinary
   *  content), so listings there never filter "field rows" out (a ref-typed
   *  VALUE pointing at a definition block would otherwise vanish). Walks the
   *  parent chain; memoized per tx — see `record` for how that memo is kept
   *  honest across mid-tx moves and stamps. */
  private async isInsidePropertySubtree(
    id: string,
    isFieldDefinition: IsPropertyFieldDefinition,
  ): Promise<boolean> {
    return isInsidePropertySubtreeWalk(
      id,
      async (rowId) => {
        const row = await this.ctx.txDb.getOptional<BlockRow>(SELECT_BY_ID_SQL, [rowId])
        return row === null ? null : parseBlockRow(row)
      },
      isFieldDefinition,
      this.propertySubtreeCache,
    )
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

  async create(data: NewBlockData, opts?: TxInsertOpts): Promise<string> {
    this.checkWorkspace(data.workspaceId)
    await this.requireParentInWorkspace(data.parentId, data.workspaceId)
    const id = data.id ?? this.ctx.newId()
    const row = this.buildNewBlockRow(id, data, opts)
    try {
      await this.ctx.txDb.execute(INSERT_SQL, blockToRowParams(row))
    } catch (e) {
      if (isUniqueConstraint(e, 'blocks.id')) throw new DuplicateIdError(id)
      throw e
    }
    this.markSystemMint(id, opts)
    this.pinWorkspace(data.workspaceId)
    this.record(id, null, row)
    return id
  }

  async createOrGet(
    data: NewBlockData & { id: string },
    opts?: TxInsertOpts,
  ): Promise<{ id: string; inserted: boolean }> {
    this.checkWorkspace(data.workspaceId)
    const existing = await this.ctx.txDb.getOptional<BlockRow>(SELECT_BY_ID_SQL, [data.id])

    if (existing === null) {
      await this.requireParentInWorkspace(data.parentId, data.workspaceId)
      const row = this.buildNewBlockRow(data.id, data, opts)
      await this.ctx.txDb.execute(INSERT_SQL, blockToRowParams(row))
      this.markSystemMint(data.id, opts)
      this.pinWorkspace(data.workspaceId)
      this.record(data.id, null, row)
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
      ...this.metadataPatch(id, before, false),
    }
    await this.ctx.txDb.execute(
      `UPDATE blocks SET deleted = 1, updated_at = ?, user_updated_at = ?, updated_by = ? WHERE id = ?`,
      [after.updatedAt, after.userUpdatedAt, after.updatedBy, id],
    )
    this.pinWorkspace(before.workspaceId)
    this.record(id, before, after)
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
      ...(patch?.referenceTargetId !== undefined
        ? {referenceTargetId: patch.referenceTargetId}
        : {}),
      ...(patch?.isFieldForm !== undefined ? {isFieldForm: patch.isFieldForm} : {}),
      // Reference-array canonicalization runs as a same-tx processor
      // (`core.normalizeReferences`) after the user fn returns —
      // see src/data/internals/normalizeReferencesProcessor.ts.
      ...(patch?.references !== undefined ? {references: patch.references} : {}),
      ...(patch?.properties !== undefined ? {properties: patch.properties} : {}),
      ...this.metadataPatch(id, beforeData, opts?.skipMetadata),
    }
    await this.ctx.txDb.execute(
      `UPDATE blocks SET deleted = 0, content = ?, reference_target_id = ?, is_field_form = ?, references_json = ?, properties_json = ?, updated_at = ?, user_updated_at = ?, updated_by = ? WHERE id = ?`,
      [
        after.content,
        after.referenceTargetId ?? null,
        after.isFieldForm ? 1 : null,
        JSON.stringify(after.references),
        JSON.stringify(after.properties),
        after.updatedAt,
        after.userUpdatedAt,
        after.updatedBy,
        id,
      ],
    )
    this.pinWorkspace(beforeData.workspaceId)
    this.record(id, beforeData, after)
  }

  // ──── Data-field updates ────

  async update(id: string, patch: BlockDataPatch, opts?: TxWriteOpts): Promise<void> {
    const before = await this.requireExisting(id)
    this.checkWorkspace(before.workspaceId)
    if (!updatePatchChangesBlock(before, patch)) return
    const after: BlockData = {
      ...before,
      ...(patch.content !== undefined ? {content: patch.content} : {}),
      ...(patch.referenceTargetId !== undefined
        ? {referenceTargetId: patch.referenceTargetId}
        : {}),
      ...(patch.isFieldForm !== undefined ? {isFieldForm: patch.isFieldForm} : {}),
      // See note on `restore` above re: same-tx normalization.
      ...(patch.references !== undefined ? {references: patch.references} : {}),
      ...(patch.properties !== undefined ? {properties: patch.properties} : {}),
      ...this.metadataPatch(id, before, opts?.skipMetadata),
    }
    await this.ctx.txDb.execute(
      `UPDATE blocks SET content = ?, reference_target_id = ?, is_field_form = ?, references_json = ?, properties_json = ?, updated_at = ?, user_updated_at = ?, updated_by = ? WHERE id = ?`,
      [
        after.content,
        after.referenceTargetId ?? null,
        after.isFieldForm ? 1 : null,
        JSON.stringify(after.references),
        JSON.stringify(after.properties),
        after.updatedAt,
        after.userUpdatedAt,
        after.updatedBy,
        id,
      ],
    )
    this.pinWorkspace(before.workspaceId)
    this.record(id, before, after)
  }

  /** See the `Tx.stampReferenceTarget` contract for the why. Impl notes: the
   *  narrow `SET reference_target_id = ?, is_field_form = ?` is load-bearing —
   *  it names no upload column and no `updated_at`, so
   *  `blocks_upload_update`'s diff predicate can't fire; `record` still
   *  clears the §9 ancestry memo and records the changed snapshot. No write /
   *  no snapshot when both columns already match. */
  async stampReferenceTarget(
    id: string,
    targetId: string | null,
    isFieldForm: boolean,
  ): Promise<void> {
    const before = await this.requireExisting(id)
    this.checkWorkspace(before.workspaceId)
    if (
      (before.referenceTargetId ?? null) === targetId
      && (before.isFieldForm ?? false) === isFieldForm
    ) return
    const after: BlockData = {...before, referenceTargetId: targetId, isFieldForm}
    await this.ctx.txDb.execute(
      `UPDATE blocks SET reference_target_id = ?, is_field_form = ? WHERE id = ?`,
      [targetId, isFieldForm ? 1 : null, id],
    )
    this.pinWorkspace(before.workspaceId)
    this.record(id, before, after)
  }

  // ──── Tree moves ────

  async move(
    id: string,
    target: { parentId: string | null; orderKey: string },
    opts?: TxWriteOpts,
  ): Promise<void> {
    const before = await this.requireExisting(id)
    this.checkWorkspace(before.workspaceId)
    const parent = await this.requireParentInWorkspace(target.parentId, before.workspaceId)
    if (target.parentId === before.parentId && target.orderKey === before.orderKey) return

    // Parent-deleted check must precede the cycle walk. The walk now
    // traverses `parent_id` regardless of `deleted` (#183), so when the
    // target parent is both soft-deleted AND a descendant of `id`, the walk
    // would report a cycle first — masking the typed `ParentDeletedError`
    // contract that callers rely on for "moving under a tombstone". The
    // BEFORE UPDATE trigger also enforces this, but only at write time
    // (after the walk), so the explicit preflight is what keeps the error
    // ordering stable.
    //
    // Gated on `!before.deleted` to match the trigger exactly: it fires only
    // for `NEW.deleted = 0`, deliberately allowing a tombstone to be
    // reparented under another tombstone (`move` never changes `deleted`, so
    // a soft-deleted row stays soft-deleted). The cycle walk below still runs
    // for deleted rows.
    if (!before.deleted && target.parentId !== null && parent?.deleted) {
      throw new ParentDeletedError(target.parentId)
    }

    // §4.7 Layer 1: FK and triggers can't structurally catch cycles, so
    // this engine check is load-bearing. Skipped when the target parent is
    // null (re-rooting can't introduce a cycle) or unchanged.
    if (
      target.parentId !== null &&
      target.parentId !== before.parentId &&
      target.parentId !== id
    ) {
      if (await this.isDescendantOf(target.parentId, id)) {
        throw new CycleError(id, target.parentId)
      }
    } else if (target.parentId === id) {
      throw new CycleError(id, id)
    }

    const after: BlockData = {
      ...before,
      parentId: target.parentId,
      orderKey: target.orderKey,
      ...this.metadataPatch(id, before, opts?.skipMetadata),
    }
    await this.ctx.txDb.execute(
      `UPDATE blocks SET parent_id = ?, order_key = ?, updated_at = ?, user_updated_at = ?, updated_by = ? WHERE id = ?`,
      [target.parentId, target.orderKey, after.updatedAt, after.userUpdatedAt, after.updatedBy, id],
    )
    this.pinWorkspace(before.workspaceId)
    this.record(id, before, after)
  }

  // ──── Typed property primitives — the codec boundary sites ────

  async resolvePropertySchema<T>(
    id: string,
    schema: PropertySchema<T>,
  ): Promise<PropertySchema<T>> {
    const before = await this.requireExisting(id)
    this.checkWorkspace(before.workspaceId)
    return this.resolvePropertySchemaForRow(before, schema)
  }

  async setProperty<T>(
    id: string,
    schema: PropertySchema<T>,
    valueOrUpdater: T | ((current: T | undefined) => T),
    opts?: TxWriteOpts,
  ): Promise<void> {
    const before = await this.requireExisting(id)
    this.checkWorkspace(before.workspaceId)
    const resolvedSchema = this.resolvePropertySchemaForRow(before, schema)
    this.assertPropertyWriteScope(resolvedSchema)
    const stored = before.properties[resolvedSchema.name]
    const value = typeof valueOrUpdater === 'function'
      ? (valueOrUpdater as (current: T | undefined) => T)(
        stored === undefined ? undefined : resolvedSchema.codec.decode(stored),
      )
      : valueOrUpdater
    const encoded = resolvedSchema.codec.encode(value)
    if (jsonValuesEqual(stored, encoded)) return
    // Dual-write (PR #288 §5): in a flipped workspace every property write is
    // child-backed — the field/value children land in the SAME tx as the cell
    // so readers stay synchronous against the cell while the children are the
    // truth that crosses sync. Requires resolved identity (the fieldId names
    // the field row); a boot-window plain schema stays cell-only.
    if (isResolvedPropertySchema(resolvedSchema) && await this.isChildBackedRow(before)) {
      await this.writePropertyValueChild(before, resolvedSchema, value)
    }
    const properties = {...before.properties, [resolvedSchema.name]: encoded}
    await this.writePropertiesBag(id, before, properties, opts)
  }

  /** The child-backing gate for a property write on `row` (schema-independent
   *  half). True only in a flipped workspace where `row` may hold field rows:
   *  a field row / property-subtree interior stays cell-only (§9 positional
   *  rule — recognition could never reclaim nested rows), as does a row whose
   *  CURRENT content is about to make it a field row (the stored column lags a
   *  same-tx content edit; PR #386 review). The per-schema half
   *  (`isResolvedPropertySchema`) is checked by the caller. */
  private async isChildBackedRow(row: BlockData): Promise<boolean> {
    return (
      await this.isPropertyChildBackedWorkspace(row.workspaceId)
      && !(await this.isInsidePropertySubtree(
        row.id, this.isFieldDefinitionCheckerFor(row.workspaceId),
      ))
      && !this.isProspectiveFieldRow(row)
    )
  }

  /** Eagerly soft-delete the field-row subtree(s) backing `schema` under
   *  `parent` — the removal counterpart to `writePropertyValueChild`. Eager
   *  (not left to the deferred MATERIALIZE pass) because MATERIALIZE diffs the
   *  tx's NET bag change: a key `setProperty`-created then removed in the SAME
   *  tx nets to "no change", so its eagerly-written children would never be
   *  reconciled and PROJECT would reproject the value back. The machinery-aware
   *  `deleteSubtreeInTx` carries any user-authored sub-children down with it
   *  (recoverable via history), matching MATERIALIZE's own removal branch. */
  private async deletePropertyValueChildren(
    parent: BlockData,
    schema: { readonly fieldId: string },
  ): Promise<void> {
    const fieldRows = await this.ctx.txDb.getAll<BlockRow>(
      SELECT_PROPERTY_FIELD_CHILD_SQL,
      [parent.workspaceId, parent.id, schema.fieldId],
    )
    for (const row of fieldRows) {
      await deleteSubtreeInTx(this, row.id)
    }
  }

  /** The identical tail of every property-bag write (`setProperty` /
   *  `unsetProperty` / `setProperties`): stamp metadata, write ONLY
   *  `properties_json` (+ metadata columns), pin, record. The three differ
   *  only in how they build `properties` and reconcile children; the cell
   *  write itself is one shape. */
  private async writePropertiesBag(
    id: string,
    before: BlockData,
    properties: Record<string, unknown>,
    opts: TxWriteOpts | undefined,
  ): Promise<void> {
    const after: BlockData = {
      ...before,
      properties,
      ...this.metadataPatch(id, before, opts?.skipMetadata),
    }
    await this.ctx.txDb.execute(
      `UPDATE blocks SET properties_json = ?, updated_at = ?, user_updated_at = ?, updated_by = ? WHERE id = ?`,
      [JSON.stringify(properties), after.updatedAt, after.userUpdatedAt, after.updatedBy, id],
    )
    this.pinWorkspace(before.workspaceId)
    this.record(id, before, after)
  }

  async unsetProperty<T>(
    id: string,
    schema: PropertySchema<T>,
    opts?: TxWriteOpts,
  ): Promise<void> {
    const before = await this.requireExisting(id)
    this.checkWorkspace(before.workspaceId)
    const resolvedSchema = this.resolvePropertySchemaForRow(before, schema)
    this.assertPropertyWriteScope(resolvedSchema)
    if (before.properties[resolvedSchema.name] === undefined) return // absent → no-op
    // Eager child delete, symmetric with setProperty's inline dual-write (see
    // deletePropertyValueChildren for why "rely on the deferred MATERIALIZE
    // pass" is unsound for a key set-then-unset in one tx).
    if (isResolvedPropertySchema(resolvedSchema) && await this.isChildBackedRow(before)) {
      await this.deletePropertyValueChildren(before, resolvedSchema)
    }
    const properties = {...before.properties}
    delete properties[resolvedSchema.name]
    await this.writePropertiesBag(id, before, properties, opts)
  }

  async setProperties(
    id: string,
    changes: {
      readonly set?: readonly AnyPropertyAssignment[]
      readonly unset?: readonly AnyPropertySchema[]
    },
    opts?: TxWriteOpts,
  ): Promise<void> {
    const before = await this.requireExisting(id)
    this.checkWorkspace(before.workspaceId)
    // Resolve + scope-check EVERY schema before any mutation, so the whole
    // batch fails atomically on an unresolvable/mis-scoped entry rather than
    // half-applying. Resolution also collapses each schema to its canonical
    // stored name (the bag key), so aliased/plain handles land on one key.
    const sets = (changes.set ?? []).map(assignment => {
      const resolvedSchema = this.resolvePropertySchemaForRow(before, assignment.schema)
      this.assertPropertyWriteScope(resolvedSchema)
      return {schema: resolvedSchema, value: assignment.value}
    })
    const unsets = (changes.unset ?? []).map(schema => {
      const resolvedSchema = this.resolvePropertySchemaForRow(before, schema)
      this.assertPropertyWriteScope(resolvedSchema)
      return resolvedSchema
    })
    // Apply the delta on a copy of the current bag: sets first, then unsets, so
    // a key named in BOTH lists ends up removed (unset wins — an explicit
    // caller intent to clear takes precedence over a stale set in the batch).
    const properties = {...before.properties}
    const unsetNames = new Set(unsets.map(schema => schema.name))
    // Encode only the sets that SURVIVE the unsets. A key named in BOTH lists is
    // cleared (unset wins), so encoding its discarded — possibly stale/invalid —
    // set value (NaN for a number, a removed enum option) would throw the whole
    // batch instead of applying the explicit clear. Symmetric with the child
    // dual-write below, which already skips unset-shadowed sets.
    for (const {schema, value} of sets) {
      if (!unsetNames.has(schema.name)) properties[schema.name] = schema.codec.encode(value)
    }
    for (const name of unsetNames) delete properties[name]
    if (jsonValuesEqual(before.properties, properties)) return // net no-op
    // Eager child dual-write, symmetric with setProperty/unsetProperty: delete
    // the field rows for unset keys first, then create/update for the sets that
    // survive (a key in both lists was removed above, so skip its child write).
    if (await this.isChildBackedRow(before)) {
      for (const schema of unsets) {
        if (isResolvedPropertySchema(schema)) await this.deletePropertyValueChildren(before, schema)
      }
      for (const {schema, value} of sets) {
        if (!unsetNames.has(schema.name) && isResolvedPropertySchema(schema)) {
          await this.writePropertyValueChild(before, schema, value)
        }
      }
    }
    await this.writePropertiesBag(id, before, properties, opts)
  }

  async getProperty<T>(id: string, schema: PropertySchema<T>): Promise<T> {
    const row = await this.ctx.txDb.getOptional<BlockRow>(SELECT_BY_ID_SQL, [id])
    if (row === null) throw new BlockNotFoundError(id)
    const data = parseBlockRow(row)
    const resolution = this.propertySchemaResolverFor(data.workspaceId)
      .resolveBoundary(schema)
    if (resolution.status === 'identity-unavailable') return schema.defaultValue
    const resolvedSchema = resolution.schema
    const stored = data.properties[resolvedSchema.name]
    if (stored === undefined) return resolvedSchema.defaultValue
    return resolvedSchema.codec.decode(stored)
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

  async childrenOf(
    parentId: string | null,
    workspaceId?: string,
    options?: {hidePropertyChildren?: boolean},
  ): Promise<BlockData[]> {
    let data: BlockData[]
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
      data = rows.map(parseBlockRow)
    } else {
      const rows = await this.ctx.txDb.getAll<BlockRow>(SELECT_CHILDREN_SQL, [parentId])
      data = rows.map(parseBlockRow)
    }
    // Default returns EVERY child (structural view). The display-visible
    // view — excluding recognized property field rows in a flipped
    // workspace (§9) — is opt-in via `hidePropertyChildren`. Cheap
    // short-circuits first — un-flipped workspaces (dormant) and listings
    // with no stamped rows pay only the (per-tx-cached) flip read; the §9
    // ancestry rule then exempts property-subtree interiors so ref-typed
    // VALUES pointing at definitions are never misread as nested fields.
    // Root listings are exempt outright: a field row is positionally a
    // child of the block that OWNS the property — a workspace-root row
    // whose content happens to be `[[some property]]` is user content, so
    // it is never filtered even under `hidePropertyChildren`.
    if (parentId === null) return data
    if (options?.hidePropertyChildren !== true || data.length === 0) return data
    if (!(await this.isPropertyChildBackedWorkspace(data[0]!.workspaceId))) return data
    const isFieldDefinition = this.isFieldDefinitionCheckerFor(data[0]!.workspaceId)
    if (!data.some(row => isPropertyFieldInstance(row, isFieldDefinition))) return data
    if (parentId !== null && await this.isInsidePropertySubtree(parentId, isFieldDefinition)) {
      return data
    }
    return data.filter(row => !isPropertyFieldInstance(row, isFieldDefinition))
  }

  async hasChildren(parentId: string, opts?: {includeDeleted?: boolean}): Promise<boolean> {
    const sql = opts?.includeDeleted ? SELECT_HAS_CHILD_INCLUDING_DELETED_SQL : SELECT_HAS_CHILD_SQL
    const row = await this.ctx.txDb.getOptional<{one: number}>(sql, [parentId])
    return row !== null
  }

  async adjacentSibling(
    anchor: SiblingAnchor,
    direction: SiblingDirection,
  ): Promise<BlockData | null> {
    const params = anchor.parentId === null
      ? [anchor.workspaceId, anchor.orderKey, anchor.orderKey, anchor.id]
      : [anchor.parentId, anchor.orderKey, anchor.orderKey, anchor.id]
    const sql = anchor.parentId === null
      ? direction === 'after'
        ? SELECT_NEXT_ROOT_SIBLING_SQL
        : SELECT_PREVIOUS_ROOT_SIBLING_SQL
      : direction === 'after'
        ? SELECT_NEXT_CHILD_SIBLING_SQL
        : SELECT_PREVIOUS_CHILD_SIBLING_SQL
    const row = await this.ctx.txDb.getOptional<BlockRow>(sql, params)
    return row === null ? null : parseBlockRow(row)
  }

  async parentOf(childId: string): Promise<BlockData | null> {
    const row = await this.ctx.txDb.getOptional<BlockRow>(SELECT_PARENT_SQL, [childId])
    return row === null ? null : parseBlockRow(row)
  }

  async isDescendantOf(id: string, potentialAncestorId: string): Promise<boolean> {
    const hit = await this.ctx.txDb.getOptional<{hit: number}>(
      IS_DESCENDANT_OF_SQL,
      [id, potentialAncestorId],
    )
    return hit !== null
  }

  async aliasLookup(alias: string, workspaceId: string): Promise<BlockData | null> {
    // Defensive: both args are required for a meaningful lookup, but a
    // bad caller passing '' would otherwise match a row whose alias
    // entry was '' (block_aliases stores empty strings; see the
    // block_aliases trigger doc in clientSchema.ts). Return null so
    // the callsite doesn't accidentally treat an empty match as a
    // claimant.
    if (alias === '' || workspaceId === '') return null
    const row = await this.ctx.txDb.getOptional<BlockRow>(
      SELECT_BLOCK_BY_ALIAS_IN_WORKSPACE_SQL,
      [workspaceId, alias],
    )
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

  emitEvent<P extends string>(name: P, payload: SameTxEventPayload<P>): void {
    if (!this.workspacePinned) throw new WorkspaceNotPinnedError()
    this.ctx.sameTxEvents.push({name, payload})
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
   *  rolled-back row.
   *
   *  Exactness depends on the commit pipeline SKIPPING its same-tx
   *  processor pass for replay txs (`runTx`'s `isReplay`, threaded from
   *  `Repo._replay`). `applyRaw`'s write is still a field change in the
   *  replay tx, so without that gate a value-deriving same-tx processor
   *  would re-derive and override the restore — leaving the row at a
   *  derived value, not `target` (#187).
   *
   *  The row-level triggers (e.g. the parent-liveness check) still fire
   *  per statement and can reject an intermediate replay state even
   *  though the target state is valid — `applyRaw` itself does no
   *  ordering or retry around that; callers own it (see
   *  `replayApplicationOrder` in txSnapshots.ts). */
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
        // Row-version stays locally monotonic (invariant I3) even on undo: a
        // device whose clock trails the server's ratcheted stamp must not
        // regress it. Undo IS a user action → fresh display stamp.
        updatedAt: Math.max(now, beforeData.updatedAt + 1),
        userUpdatedAt: now,
        updatedBy: userId,
      }
      await this.ctx.txDb.execute(
        `UPDATE blocks SET deleted = 1, updated_at = ?, user_updated_at = ?, updated_by = ? WHERE id = ?`,
        [after.updatedAt, now, userId, id],
      )
      this.pinWorkspace(beforeData.workspaceId)
      this.record(id, beforeData, after)
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
        // Undo IS a user action; also overrides a pre-migration snapshot's
        // missing `userUpdatedAt` (the `...target` spread would carry undefined).
        userUpdatedAt: now,
        updatedBy: userId,
      }
      await this.ctx.txDb.execute(INSERT_SQL, blockToRowParams(inserted))
      this.pinWorkspace(target.workspaceId)
      this.record(id, null, inserted)
      return
    }

    // Row exists; UPDATE all non-immutable fields to match target.
    // workspace_id, id, created_at, created_by are immutable by
    // contract (§4.1.1) and the snapshot's values for these match
    // the row's current values when the original tx pre-existed the
    // row. updated_at / updated_by stamp the replay action.
    const after: BlockData = {
      ...target,
      // Locally monotonic row-version (invariant I3) — see the soft-delete
      // branch above. Undo IS a user action → fresh display stamp (also
      // overrides a pre-migration snapshot's missing `userUpdatedAt`).
      updatedAt: Math.max(now, beforeData.updatedAt + 1),
      userUpdatedAt: now,
      updatedBy: userId,
    }
    await this.ctx.txDb.execute(
      `UPDATE blocks SET parent_id = ?, reference_target_id = ?, is_field_form = ?, order_key = ?, content = ?, properties_json = ?, references_json = ?, deleted = ?, updated_at = ?, user_updated_at = ?, updated_by = ? WHERE id = ?`,
      [
        target.parentId,
        // Undo replay must restore the local derived columns too: same-tx
        // processors are skipped on replay (`isReplay`), so nothing
        // re-derives them — the snapshot is the only source (invariants
        // index, PR #288: "undo restores what processors won't re-derive").
        target.referenceTargetId ?? null,
        target.isFieldForm ? 1 : null,
        target.orderKey,
        target.content,
        JSON.stringify(target.properties),
        JSON.stringify(target.references),
        target.deleted ? 1 : 0,
        after.updatedAt,
        now,
        userId,
        id,
      ],
    )
    this.pinWorkspace(beforeData.workspaceId)
    this.record(id, beforeData, after)
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

  /** Record that `id` was just system-minted in this tx, so same-tx
   *  follow-up shaping writes (`setProperty` / `addTypeInTx` / …) keep its
   *  `updated_at` pinned at the `0` pristine sentinel instead of advancing it
   *  (see `metadataPatch` and `systemMintedIds`). Without this, the same-tx
   *  shaping a deterministic-id mint does — and the upload compactor's
   *  PUT+PATCH fusion — would overwrite the `0`, so the sentinel the reconcile
   *  gate lets yield to the server would never exist. No-op unless
   *  `opts.systemMint` — and `systemMint` is insert-only at the type level
   *  ({@link TxInsertOpts}), so this is only ever reached from
   *  `create` / `createOrGet`. */
  private markSystemMint(id: string, opts: TxInsertOpts | undefined): void {
    if (opts?.systemMint) this.systemMintedIds.add(id)
  }

  /** Metadata stamps for a content-changing write to `id`.
   *  - `updatedAt` (the row-version / sync-gate discriminator) ALWAYS advances
   *    and is locally monotonic (invariant I3): `max(now, before.updatedAt + 1)`,
   *    so a fresh local edit can never stamp at or below the row's current
   *    version even when the server has ratcheted ahead of this device's clock.
   *    EXCEPT ids system-minted in THIS tx, held at the `0` pristine sentinel
   *    (see `markSystemMint`).
   *  - `userUpdatedAt` (display) + `updatedBy` advance only on a real user
   *    edit; a `{skipMetadata}` bookkeeping write leaves them untouched while
   *    still advancing `updatedAt`. `updatedBy` is now a plain user-pair field
   *    (no `system:` prefix) — the gate reads `updatedAt === 0` for pristineness. */
  private metadataPatch(
    id: string,
    before: BlockData,
    skipMetadata?: boolean,
  ):
    | {updatedAt: number}
    | {updatedAt: number; userUpdatedAt: number; updatedBy: string} {
    const now = this.ctx.now()
    const updatedAt = this.systemMintedIds.has(id) ? 0 : Math.max(now, before.updatedAt + 1)
    if (skipMetadata) return {updatedAt}
    return {updatedAt, userUpdatedAt: now, updatedBy: this.meta.user.id}
  }

  /** Build a fresh BlockData for `tx.create` / `tx.createOrGet` insert
   *  paths. Engine sets all metadata columns from tx_context unless
   *  `opts.skipMetadata` (used only by bookkeeping writes).
   *
   *  `opts.systemMint` marks the row as a speculative default the reconcile
   *  gate can let yield: it stamps `updated_at = 0` (the pristine sentinel the
   *  gate's stamp-0 exemption recognizes), while `created_by` / `updated_by`
   *  stay the REAL user — authorship is no longer the discriminator (the gate
   *  reads `updated_at === 0`, not a `system:` prefix). The first real edit in
   *  a later tx ratchets `updated_at` off 0 via `metadataPatch`'s I3 floor. */
  private buildNewBlockRow(
    id: string,
    data: NewBlockData,
    opts: TxInsertOpts | undefined,
  ): BlockData {
    const now = this.ctx.now()
    const userId = this.meta.user.id
    // `updated_at` is the row-version. A speculative `systemMint` default and a
    // `skipMetadata` bookkeeping create are born at the `0` pristine sentinel so
    // the reconcile gate lets the server win; a normal create starts at `now`.
    const updatedAt = opts?.skipMetadata || opts?.systemMint ? 0 : now
    // `sourceTimestamps` (import/restore) stamps the origin + display fields
    // from a trusted external source while leaving `updated_at` engine-owned
    // above. Suppressed under `skipMetadata` — a 0-sentinel bookkeeping insert
    // has no source provenance.
    const source = opts?.skipMetadata ? undefined : opts?.sourceTimestamps
    const createdAt = opts?.skipMetadata ? 0 : source?.createdAt ?? now
    const createdBy = opts?.skipMetadata ? '' : userId
    // `updated_by` is a plain user-pair field — the real user even for a
    // systemMint (no more `system:` prefix; the gate reads `updated_at === 0`).
    const updatedBy = opts?.skipMetadata ? '' : userId
    return {
      id,
      workspaceId: data.workspaceId,
      parentId: data.parentId,
      referenceTargetId: data.referenceTargetId ?? null,
      isFieldForm: data.isFieldForm ?? false,
      orderKey: data.orderKey,
      content: data.content ?? '',
      properties: data.properties ?? {},
      // Same-tx `core.normalizeReferences` canonicalizes after the
      // user fn returns; empty default is already canonical so the
      // common (no-refs) insert path is a same-tx no-op.
      references: data.references ?? [],
      createdAt,
      updatedAt,
      // Display "last edited" = creation moment for every create, including the
      // `0`-versioned pristine/bookkeeping rows (so they never show 1970) —
      // unless an import/restore sourced it from the original edit-time.
      userUpdatedAt: source?.userUpdatedAt ?? now,
      createdBy,
      updatedBy,
      deleted: false,
    }
  }

  private async requireExisting(id: string): Promise<BlockData> {
    const ownWrite = peekSnapshot(this.ctx.snapshots, id)
    if (ownWrite !== undefined) {
      if (ownWrite === null) throw new BlockNotFoundError(id)
      return ownWrite
    }
    const row = await this.ctx.txDb.getOptional<BlockRow>(SELECT_BY_ID_SQL, [id])
    if (row === null) throw new BlockNotFoundError(id)
    return parseBlockRow(row)
  }

  /** Child half of the §5 dual-write: find-or-create the field row
   *  (`[[Schema Name]]` + fieldId in the local column) and its ONE primary
   *  value child (scalar-first), updating stale content and soft-deleting
   *  duplicates deterministically (`ORDER BY order_key, id` picks the same
   *  survivor on every replica — load-bearing for the processor pair's
   *  convergence, see propertyChildrenProcessor.ts). Ported from the PR #285
   *  spike; identity comes from the resolved schema (never a synthetic
   *  name-derived id). */
  private async writePropertyValueChild<T>(
    parent: BlockData,
    schema: PropertySchema<T> & {readonly fieldId: string},
    value: T,
  ): Promise<void> {
    const content = propertyValueToChildContent(schema, value)
    const fieldRows = await this.ctx.txDb.getAll<BlockRow>(
      SELECT_PROPERTY_FIELD_CHILD_SQL,
      [parent.workspaceId, parent.id, schema.fieldId],
    )
    const existing = fieldRows.length > 0 ? parseBlockRow(fieldRows[0]!) : undefined

    if (existing) {
      // Child-backed field/value rows are synced data: update their content
      // with REAL metadata (no `opts`) — same as the create path below and the
      // deferred materialize processor (propertyChildrenProcessor.ts, which
      // passes none). Forwarding the parent write's {skipMetadata} here would
      // stamp these synced rows' user_updated_at/updated_by inconsistently
      // depending on whether the change went through the eager dual-write or
      // the deferred processor for the same logical value.
      if (existing.content !== propertyFieldContent(schema.fieldId)) {
        await this.update(existing.id, {content: propertyFieldContent(schema.fieldId)})
      }
      const values = await this.childrenOf(existing.id, undefined)
      const [primary, ...duplicates] = values
      if (primary) {
        if (primary.content !== content) await this.update(primary.id, {content})
        // §9 dedup — fold ONLY exact duplicates of the value we just wrote
        // (concurrent dual-writes of the same value), matching the deferred
        // materialize processor (propertyChildrenProcessor.ts). A DIVERGENT
        // peer value — e.g. a merge's surfaced conflict — is kept, not silently
        // collapsed onto the winner: a raw `tx.update({properties})` preserves
        // it via materialize, so this eager path must too. The shared
        // relocate-then-subtree-delete helper keeps the loser's user-authored
        // sub-children under the primary when a fold does happen.
        for (const duplicate of duplicates) {
          if (duplicate.content === content) {
            await collapseDuplicateValueChild(this, primary.id, duplicate)
          }
        }
      } else {
        await this.create({
          workspaceId: parent.workspaceId,
          parentId: existing.id,
          orderKey: keyAtStart(null),
          content,
        })
      }
      return
    }

    // Machinery inserts field rows FIRST among children (§9 ordering
    // decision): fields cluster above content as an emergent default;
    // orderKey stays user-owned afterwards.
    //
    // Canonical child-backed property rows are synced data — create them
    // with real metadata (matching the post-commit materialize processor,
    // which passes no opts). The parent write's {skipMetadata} governs the
    // PARENT's updated_at only; forwarding it here would birth these synced
    // rows with created_at=0 / created_by='' (Codex review, PR #386).
    const fieldRowId = await this.create({
      workspaceId: parent.workspaceId,
      parentId: parent.id,
      referenceTargetId: schema.fieldId,
      orderKey: keyAtStart(null),
      content: propertyFieldContent(schema.fieldId),
    })
    await this.create({
      workspaceId: parent.workspaceId,
      parentId: fieldRowId,
      orderKey: keyAtStart(null),
      content,
    })
  }

  private async requireParentInWorkspace(
    parentId: string | null,
    childWorkspaceId: string,
  ): Promise<{deleted: boolean} | null> {
    if (parentId === null) return null
    const parent = await this.ctx.txDb.getOptional<{workspace_id: string; deleted: number}>(
      SELECT_PARENT_WORKSPACE_SQL,
      [parentId],
    )
    if (parent === null) throw new ParentNotFoundError(parentId)
    if (parent.workspace_id !== childWorkspaceId) {
      throw new ParentWorkspaceMismatchError(parentId, parent.workspace_id, childWorkspaceId)
    }
    return {deleted: parent.deleted === 1}
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
