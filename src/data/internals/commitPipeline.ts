/**
 * Commit pipeline (§10): drives a `repo.tx` invocation end-to-end.
 *
 *   1. Validate scope vs. read-only mode.
 *   2. Open `db.writeTransaction(fn)`.
 *      a. Set `tx_context` (tx_id, user_id, scope, source).
 *      b. Construct TxImpl + snapshots map.
 *      c. Run user fn (primitives write through to SQL inline).
 *      d. INSERT command_events row.
 *      e. Clear `tx_context` (all four → NULL).
 *   3. On COMMIT (post-fn-resolve, before promise resolves):
 *      a. Walk snapshots map: update cache to `after` per id (or evict
 *         on hard-delete).
 *      b. (Future) record undo entry.
 *      c. Resolve repo.tx promise with user fn's return.
 *   4. Post-resolve: dispatch afterCommit jobs (their own
 *      writeTransactions). (Stage 1.3: jobs collected only; the
 *      processor framework that actually fires them lands in 1.5.)
 *
 * Failure modes:
 *   - User fn throws → SQLite rolls back the writeTransaction. Snapshots
 *     map is discarded. **Cache was never mutated**, so there's nothing
 *     to revert; outside-tx readers saw the pre-tx state throughout.
 *     afterCommit jobs are discarded — they only fire on commit (§5.3).
 *   - DB error inside the writeTransaction → same rollback path.
 */

import type {
  AnyMutator,
  AnyPostCommitProcessor,
  ChangeScope,
  RepoTxOptions,
  Tx,
  User,
} from '@/data/api'
import { ReadOnlyError, ChangeScope as ChangeScopeConst } from '@/data/api'
import {
  newTxMeta,
  TxImpl,
  type AfterCommitJob,
  type MutatorCallRecord,
  type TxDb,
} from './txEngine'
import { newSnapshotsMap, type SnapshotsMap } from './txSnapshots'
import type { BlockCache } from '@/data/blockCache'

const sourceForScope = (scope: ChangeScope) =>
  scope === ChangeScopeConst.UiState ? 'local-ephemeral' : 'user'

const scopeUploadsToServer = (scope: ChangeScope) =>
  scope === ChangeScopeConst.BlockDefault || scope === ChangeScopeConst.References

/** Minimal subset of the full PowerSync DB our pipeline + Repo talks
 *  to. The test harness (`createTestDb`) returns a real
 *  `PowerSyncDatabase` that satisfies this; production passes the
 *  same. Both `writeTransaction` (for tx primitives) and the read
 *  surface (`getAll` / `getOptional` / `get` for `repo.load`) are
 *  needed. `onChange` is the table-change subscription used by hooks
 *  (`useBacklinks`, `useChildIds`) until the row_events tail in
 *  Phase 2 ships a typed invalidation surface. */
export interface PowerSyncDbChangeHandler {
  onChange: () => void | Promise<void>
  onError?: (error: unknown) => void
}

export interface PowerSyncDbChangeOptions {
  tables?: readonly string[]
  throttleMs?: number
}

export interface PowerSyncDb {
  writeTransaction<R>(fn: (tx: TxDb) => Promise<R>): Promise<R>
  getAll<T>(sql: string, params?: unknown[]): Promise<T[]>
  getOptional<T>(sql: string, params?: unknown[]): Promise<T | null>
  get<T>(sql: string, params?: unknown[]): Promise<T>
  /** Execute an arbitrary SQL statement (no result rows). Used by the
   *  agent runtime bridge for `mode='execute'` SQL. Avoid in
   *  application code — every write should go through `repo.tx`. */
  execute(sql: string, params?: unknown[]): Promise<unknown>
  onChange(
    handler: PowerSyncDbChangeHandler,
    options?: PowerSyncDbChangeOptions,
  ): () => void
  /** Release the underlying connection (OPFS sync access handle on
   *  web, file handle in node). Used by `exportSqliteDb` when
   *  swapping the live .db file out from under the worker. */
  close(): Promise<void>
}

export interface RunTxParams<R> {
  db: PowerSyncDb
  cache: BlockCache
  fn: (tx: Tx) => Promise<R>
  opts: RepoTxOptions
  user: User
  isReadOnly: boolean
  newTxId: () => string
  /** Monotonically increasing INTEGER per `repo.tx`. Written into
   *  `tx_context.tx_seq` so the upload-routing triggers can stamp
   *  `ps_crud.tx_id` and PowerSync's `getNextCrudTransaction()` groups
   *  multi-row writes correctly. Required to be strictly increasing
   *  across calls within a single `Repo`; the default Repo provider
   *  uses a counter seeded from `Date.now()`. */
  newTxSeq: () => number
  newId: () => string
  now: () => number
  mutators: ReadonlyMap<string, AnyMutator>
  /** Processor registry snapshot, captured at tx start. Used by
   *  `tx.afterCommit` to validate scheduledArgs at enqueue time. */
  processors: ReadonlyMap<string, AnyPostCommitProcessor>
}

export interface TxResult<R> {
  /** User fn's return value (resolved synchronously after commit walk). */
  value: R
  /** afterCommit jobs scheduled by the tx — to be dispatched by the
   *  caller (Repo) after the tx promise resolves. Empty if rollback. */
  afterCommitJobs: AfterCommitJob[]
  /** Snapshots map for the committed tx — used by the post-commit
   *  processor framework to compute field-watch matches. Empty map if
   *  the user fn made no writes. */
  snapshots: SnapshotsMap
  /** Pinned workspace at commit time. `null` for zero-write txs;
   *  CommittedEvent contracts on this being a string when present, so
   *  the runner skips field-watch + explicit dispatch entirely when
   *  null (no work to do anyway — no field changed, and afterCommit
   *  threw WorkspaceNotPinnedError if called pre-write). */
  workspaceId: string | null
  /** Tx id (for processor CommittedEvent.txId). */
  txId: string
  /** User who ran the tx (for processor CommittedEvent.user). */
  user: User
  /** Processor registry snapshot taken at tx start. The runner walks
   *  this (not its current registry) so a `setFacetRuntime` call that
   *  lands while a tx is in flight can't remove or replace processors
   *  before that tx's field-watch / explicit jobs fire — the spec says
   *  registries are snapshotted at tx start (§3, §8). */
  processors: ReadonlyMap<string, AnyPostCommitProcessor>
}

export const runTx = async <R>(params: RunTxParams<R>): Promise<TxResult<R>> => {
  const {
    db, cache, fn, opts, user, isReadOnly,
    newTxId, newTxSeq, newId, now,
    mutators, processors,
  } = params
  const {scope, description} = opts

  // §10.3 read-only gate. UiState is always allowed (local chrome state).
  if (isReadOnly && scope !== ChangeScopeConst.UiState) {
    throw new ReadOnlyError(scope)
  }

  const txId = newTxId()
  const txSeq = newTxSeq()
  const source = sourceForScope(scope)
  const snapshots: SnapshotsMap = newSnapshotsMap()
  const afterCommitJobs: AfterCommitJob[] = []
  // `tx.run` pushes onto this list each time a mutator runs (including
  // the outer call from `repo.mutate.X` / `repo.run` since those open
  // the tx with `fn = tx => tx.run(m, args)`). Pipeline serializes
  // the list at commit time into command_events.mutator_calls.
  const mutatorCalls: MutatorCallRecord[] = []
  const meta = newTxMeta({txId, scope, source, user, description})

  // Run inside writeTransaction. Steps 1-5 commit or roll back atomically.
  const value = await db.writeTransaction(async (txDb): Promise<R> => {
    // Step 1: set tx_context — triggers read this for source-tagging
    // row_events + gating upload routing + gating workspace-invariant
    // checks (§4.1.1, §4.3, §4.5). tx_seq is the integer key the
    // upload triggers stamp into ps_crud.tx_id so PowerSync's
    // getNextCrudTransaction() groups multi-row writes correctly.
    await txDb.execute(
      `UPDATE tx_context SET tx_id = ?, tx_seq = ?, user_id = ?, scope = ?, source = ? WHERE id = 1`,
      [txId, txSeq, user.id, scope, source],
    )

    // Step 2: construct Tx + snapshots map + run user fn.
    const tx = new TxImpl({
      txDb,
      snapshots,
      cache,
      meta,
      afterCommitJobs,
      mutatorCalls,
      mutators,
      processors,
      now,
      newId,
    })
    // Important: any tx.run calls in the user fn push onto
    // `mutatorCalls` after the dispatch wrapper's initial entry. We
    // capture the running list (mutating closure) rather than passing
    // a snapshot so the command_events row written in step 4 reflects
    // every mutator the tx actually ran.
    const result = await fn(tx)

    // Step 4: write command_events row — one per repo.tx invocation
    // (per §4.4). workspace_id is the pinned value (or NULL on
    // zero-write txs). source uniformly tags 'user' / 'local-ephemeral';
    // sync-applied writes don't go through repo.tx.
    await txDb.execute(
      `INSERT INTO command_events
        (tx_id, description, scope, user_id, workspace_id, mutator_calls, source, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        txId,
        description ?? null,
        scope,
        user.id,
        meta.workspaceId,
        // mutatorCalls is mutated in place during the user fn (each
        // tx.run pushes a record). Serialized at commit time so audit
        // sees every mutator this tx invoked. Raw `repo.tx(fn, opts)`
        // calls with no tx.run produce '[]' — same as zero-write txs.
        JSON.stringify(mutatorCalls),
        source,
        now(),
      ],
    )

    // Step 5: clear tx_context. Doing this inside the writeTransaction
    // means rollback restores the pre-tx state atomically — no risk of
    // a stale tx_id / tx_seq leaking into a sync-applied row_event or
    // ps_crud row after a crashed local tx (the trigger CASE on
    // `source IS NULL` is the belt-and-suspenders backup for row_events;
    // this clear is the primary).
    await txDb.execute(
      `UPDATE tx_context SET tx_id = NULL, tx_seq = NULL, user_id = NULL, scope = NULL, source = NULL WHERE id = 1`,
    )

    return result
  })

  // Step 6: post-COMMIT cache walk. Update cache to `after` per id
  // (deepFrozen by BlockCache.setSnapshot). Outside-tx readers begin
  // observing committed state from this point.
  for (const [id, entry] of snapshots) {
    if (entry.after === null) {
      cache.deleteSnapshot(id)
    } else {
      cache.setSnapshot(entry.after)
    }
  }

  // Step 9 — return everything Repo needs to dispatch field-watch +
  // explicit processors. Repo wraps this with its ProcessorRunner.
  return {
    value,
    afterCommitJobs,
    snapshots,
    workspaceId: meta.workspaceId,
    txId,
    user,
    processors,
  }
}

// Internal export for tests / debug — `scopeUploadsToServer` documents
// which scopes are upload-bound at the engine level (matches the
// upload-routing trigger gate `source = 'user'`).
export const __debug = {scopeUploadsToServer}
