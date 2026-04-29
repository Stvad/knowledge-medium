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

import type { ChangeScope, RepoTxOptions, Tx, User, Mutator } from '@/data/api'
import { ReadOnlyError, ChangeScope as ChangeScopeConst } from '@/data/api'
import {
  newTxMeta,
  TxImpl,
  type AfterCommitJob,
  type TxDb,
} from './txEngine'
import { newSnapshotsMap, type SnapshotsMap } from './txSnapshots'
import type { BlockCache } from '@/data/blockCache'

const sourceForScope = (scope: ChangeScope) =>
  scope === ChangeScopeConst.UiState ? 'local-ephemeral' : 'user'

const scopeUploadsToServer = (scope: ChangeScope) =>
  scope === ChangeScopeConst.BlockDefault || scope === ChangeScopeConst.References

/** Minimal subset of the full PowerSync DB our pipeline talks to. The
 *  test harness (`createTestDb`) returns a real `PowerSyncDatabase`
 *  that satisfies this; production passes the same. */
export interface PowerSyncDb {
  writeTransaction<R>(fn: (tx: TxDb) => Promise<R>): Promise<R>
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
  mutators: ReadonlyMap<string, Mutator<unknown, unknown>>
}

export interface TxResult<R> {
  /** User fn's return value (resolved synchronously after commit walk). */
  value: R
  /** afterCommit jobs scheduled by the tx — to be dispatched by the
   *  caller (Repo) after the tx promise resolves. Empty if rollback. */
  afterCommitJobs: AfterCommitJob[]
}

export const runTx = async <R>(params: RunTxParams<R>): Promise<TxResult<R>> => {
  const {db, cache, fn, opts, user, isReadOnly, newTxId, newTxSeq, newId, now, mutators} = params
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
      mutators,
      now,
      newId,
    })
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
        // Mutator-call list lands when registries populate in stage
        // 1.4. For now record an empty array — uniform shape, callable
        // from raw repo.tx with no mutators required.
        '[]',
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

  // Step 9 jobs are returned — Repo dispatches them after resolving.
  // (Currently the framework that runs them lands in stage 1.5.)
  return {value, afterCommitJobs}
}

// Internal export for tests / debug — `scopeUploadsToServer` documents
// which scopes are upload-bound at the engine level (matches the
// upload-routing trigger gate `source = 'user'`).
export const __debug = {scopeUploadsToServer}
