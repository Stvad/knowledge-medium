/**
 * Layout B observer — the driver (design doc §9.2).
 *
 * Ties the change-capture queue, the materialization core, and the
 * invalidation relocation into the running sync seam. PowerSync writes
 * downloaded rows into the raw `blocks_synced` staging table; AFTER triggers
 * append `(seq, id, op)` to `blocks_synced_changes`; this driver drains that
 * log and turns each change into the app-visible plaintext `blocks` table.
 *
 * DRAIN (race- and failure-safe, the row_events watermark pattern). Loops over
 * the queue in bounded seq-ordered windows ({@link DEFAULT_DRAIN_CHUNK}) until
 * it's empty — a large initial sync or a long observer-down backlog can queue
 * hundreds of thousands of changes, and one unbounded pass would build the whole
 * working set in memory and wrap every write in a single transaction. Per window:
 *   1. read the next <= chunk changes (ORDER BY seq LIMIT chunk),
 *   2. dedup per id (latest op wins — a hot row materializes once per window),
 *   3. `materializeStagingRows` (decrypt/copy/defer/skip/delete) +
 *      `applySyncInvalidation` (cache + handles, one LWW gate),
 *   4. `DELETE … WHERE seq <= <that window's max>`.
 * A delivery that lands mid-drain gets a higher seq, so step 4 can't drop it —
 * it's picked up by a later window. If any step throws, that window's delete is
 * skipped (prior committed windows survive) and the rows retry next tick.
 *
 * Drains serialize on a single promise chain, so two never overlap (duplicate
 * invalidations) and `flush()` is a real settle barrier for tests. A barrier
 * only settles as SUCCESS when the drain finished: a unit that throws or is
 * cut short by `dispose()` rejects the promise it was awaited on, because the
 * awaiters treat resolution as "the workspace is materialized" and act on it
 * irreversibly.
 *
 * `drainWorkspace` re-materializes a workspace's staged rows directly from
 * `blocks_synced` (not the queue) — for when a workspace becomes
 * materializable without a staging change: a WK paste (deferred e2ee rows) or
 * a plaintext confirmation (§8 flows call it). Because it stages nothing, the
 * queue cannot report it; `isRematerializingWorkspace` is how a reader learns
 * `blocks` is being rewritten under it.
 *
 * It is also the only thing that can re-deliver a row the drain reached and
 * could not apply — the durable gap `WORKSPACE_UNAPPLIED_SQL` counts, whose
 * queue entry is long since consumed. That is why it takes a
 * {@link RematerializeScope}: `unapplied` re-runs the drain over exactly those
 * rows, which is an operator's remedy for a refusal rather than a full pass
 * over the workspace (`Repo.rematerializeWorkspace`).
 *
 * The §4.7 cycle-scan telemetry that lived in rowEventsTail is relocated here
 * (`runCycleScan`), so the observer fully subsumes the tail's responsibilities.
 */

import type { CycleDetectedEvent } from '@/data/api'
import type { PowerSyncDb } from '@/data/internals/commitPipeline.js'
import type { InvalidationRule } from '@/data/invalidation.js'
import { cycleScanSql } from '@/data/internals/treeQueries.js'
import {
  materializeStagingRows,
  type MaterializeDeps,
  type MaterializeOutcome,
  type SyncSnapshot,
} from './materialize.js'
import {
  applySyncInvalidation,
  type SyncCache,
  type SyncInvalidationTarget,
} from './invalidate.js'
import { WORKSPACE_UNAPPLIED_IDS_SQL } from './reconcile.js'

/** Drain-throttle window (ms). Matches the row_events tail default — coalesces
 *  sync-burst arrivals into one batched drain. */
const DEFAULT_THROTTLE_MS = 100

/** Max queued changes materialized per drain window. Draining a large backlog in
 *  bounded, individually-committed windows (rather than one unbounded pass) keeps
 *  memory flat, makes progress durable across reloads/crashes, and lets the UI
 *  fill in as it goes: the queue is consumed per window, so an interrupted drain
 *  resumes from the last committed window instead of restarting from zero. */
const DEFAULT_DRAIN_CHUNK = 1000

export interface BlocksSyncedObserverArgs {
  readonly db: PowerSyncDb
  readonly cache: SyncCache
  readonly handleStore: SyncInvalidationTarget
  readonly deps: MaterializeDeps
  /** Plugin invalidation rules, read fresh each drain (plugins can register
   *  after the observer starts). */
  readonly getInvalidationRules?: () => readonly InvalidationRule[]
  /** §4.7 cycle-detection telemetry. Fired (with a console.warn) when a
   *  sync-applied parent_id change closes a loop — relocated from
   *  rowEventsTail. txIdsInvolved is always empty (sync writes carry no tx_id). */
  readonly onCycleDetected?: (event: CycleDetectedEvent) => void
  readonly throttleMs?: number
  /** Max changes materialized per drain window (default {@link DEFAULT_DRAIN_CHUNK}).
   *  Tests shrink it to exercise multi-window backlogs. */
  readonly drainChunkSize?: number
  readonly onError?: (err: unknown) => void
}

/** Which of a workspace's staged rows a {@link BlocksSyncedObserver.drainWorkspace}
 *  pass re-materializes.
 *
 *  `unapplied` is the population {@link WORKSPACE_UNAPPLIED_IDS_SQL} names — the
 *  rows a durable-gap refusal is counting, and nothing else. `all` is every
 *  staged row of the workspace, which is what a gate-resolution rescan wants:
 *  it also re-judges rows the flag says are fine, so it is the one that can
 *  repair a row whose flag is wrong (a pre-flag legacy shadow), and the one
 *  that costs a full pass over the workspace to do it. */
export type RematerializeScope = 'all' | 'unapplied'

/** What one queue-less rematerialization pass did, summed over its windows.
 *
 *  Every count is per row and the id set is distinct, so they partition
 *  `scanned` — except `resolved`, which is orthogonal (it counts the rows whose
 *  `needs_apply` flag the pass cleared, by any of the drain's reasons).
 *
 *  The point of reporting `deferred` and `quarantined` separately: when a pass
 *  does NOT close the gap, these are why. Deferred means the workspace was not
 *  materializable (locked e2ee, mode unresolved, a key-store read that failed);
 *  quarantined means the ciphertext did not decode. Neither is fixed by running
 *  the pass again. */
export interface RematerializeReport {
  readonly scope: RematerializeScope
  /** Staged rows the pass fed to the drain. */
  readonly scanned: number
  readonly applied: number
  readonly deferred: number
  readonly skippedStale: number
  readonly quarantined: number
  /** Rows whose `needs_apply` flag this pass cleared. */
  readonly resolved: number
}

export interface BlocksSyncedObserver {
  /** Drain the pending queue once. Awaitable settle barrier (awaits every
   *  drain enqueued before it). */
  flush(): Promise<void>
  /** Re-materialize a workspace's staged rows after it becomes materializable
   *  (WK paste / plaintext confirm), as the on-open recovery rescan, or because
   *  an operator asked. Reads `blocks_synced` directly. Server-enforced
   *  `updated_at` monotonicity makes one gate correct for all of them — no
   *  separate healing mode.
   *
   *  REJECTS if the pass did not finish — see {@link startBlocksSyncedObserver}'s
   *  enqueue. */
  drainWorkspace(workspaceId: string, scope?: RematerializeScope): Promise<RematerializeReport>
  /** Is a {@link drainWorkspace} pass for `workspaceId` outstanding (running OR
   *  queued behind another unit)? The one thing a reader cannot learn from the
   *  queue: that path rewrites `blocks` straight from `blocks_synced` and
   *  stages nothing, so `blocks_synced_changes` is empty throughout. The
   *  observer's own in-flight state, which is what `clientSchema.ts` asks for
   *  in place of proxying one of its inputs.
   *
   *  Per WORKSPACE, not device-wide: a rescan of the workspace someone just
   *  navigated away from would otherwise refuse every pass on the one they are
   *  in now, for as long as it runs. */
  isRematerializingWorkspace(workspaceId: string): boolean
  /** Stop the subscription. Idempotent. */
  dispose(): void
}

interface QueueRow {
  readonly seq: number
  readonly id: string
  readonly op: 'upsert' | 'delete'
}

/** PowerSync raises this from in-flight queries when the connection closes
 *  mid-drain (tab close / signOut / test teardown). Benign — there's nobody
 *  left to materialize for. Identified by name to avoid a runtime dep on
 *  `@powersync/common`. */
const isConnectionClosedError = (err: unknown): boolean =>
  !!err && typeof err === 'object' && (err as { name?: unknown }).name === 'ConnectionClosedError'

/** Raised instead of returning when a drain is cut short by `dispose()`. An
 *  interrupted pass did not materialize the workspace, and its awaiter decides
 *  what that means — see {@link startBlocksSyncedObserver}'s enqueue.
 *
 *  Branded by `name`, like {@link isConnectionClosedError} and for the same
 *  reason: it rejects the awaiter but is never REPORTED. Teardown is expected,
 *  and the fire-and-forget drains would warn on every tab close. */
const DISPOSED_MID_DRAIN = 'ObserverDisposedError'

const disposedMidDrain = (): Error =>
  Object.assign(new Error('[blocksSyncedObserver] disposed before this drain finished'),
    { name: DISPOSED_MID_DRAIN })

const isDisposedMidDrain = (err: unknown): boolean =>
  !!err && typeof err === 'object' && (err as { name?: unknown }).name === DISPOSED_MID_DRAIN

/**
 * The §4.7 cycle-scan starting set: ids whose parent_id actually moved while
 * the row stayed live (a fresh insert or a delete can't close a loop on its
 * own; a content edit doesn't change reachability), grouped by the row's
 * current workspace. Relocated from rowEventsTail's inline selection.
 */
export const cycleScanCandidatesByWorkspace = (
  snapshots: ReadonlyMap<string, SyncSnapshot>,
): Map<string, string[]> => {
  const byWorkspace = new Map<string, string[]>()
  for (const [id, { before, after }] of snapshots) {
    if (!before || before.deleted) continue
    if (!after || after.deleted) continue
    if (before.parentId === after.parentId) continue
    const workspaceId = after.workspaceId
    if (!workspaceId) continue
    const list = byWorkspace.get(workspaceId)
    if (list) list.push(id)
    else byWorkspace.set(workspaceId, [id])
  }
  return byWorkspace
}

export const startBlocksSyncedObserver = (
  args: BlocksSyncedObserverArgs,
): BlocksSyncedObserver => {
  const { db, cache, handleStore, deps, getInvalidationRules, onCycleDetected } = args
  const throttleMs = args.throttleMs ?? DEFAULT_THROTTLE_MS
  const drainChunk = Math.max(1, args.drainChunkSize ?? DEFAULT_DRAIN_CHUNK)
  const rules = (): readonly InvalidationRule[] => getInvalidationRules?.() ?? []
  const onError = args.onError ?? ((err: unknown) => {
    if (!isConnectionClosedError(err)) console.warn('[blocksSyncedObserver] drain error:', err)
  })

  let disposed = false
  let unsubscribe: (() => void) | null = null
  let chain: Promise<void> = Promise.resolve()
  /** Outstanding {@link drainWorkspace} passes per workspace — the queue-blind
   *  path, read by the view-gap predicate on `Repo`. What the drain FAILED to
   *  apply is not tracked here: it is written to the staging row itself, in the
   *  transaction that decides it (`STAGING_NEEDS_APPLY_COLUMN`). */
  const workspaceRescans = new Map<string, number>()

  /** §4.7 detection-only telemetry. One bounded, truncation-safe scan per
   *  workspace whose parent_id mutations might have closed a loop. A scan
   *  failure is reported but never aborts the drain (matches rowEventsTail). */
  const runCycleScan = async (snapshots: ReadonlyMap<string, SyncSnapshot>): Promise<void> => {
    if (!onCycleDetected) return
    for (const [workspaceId, ids] of cycleScanCandidatesByWorkspace(snapshots)) {
      try {
        const hits = await db.getAll<{ start_id: string }>(cycleScanSql(ids.length), ids)
        if (hits.length === 0) continue
        const startIds = hits.map(hit => hit.start_id).sort()
        console.warn(`[blocksSyncedObserver] cycleDetected ws=${workspaceId} startIds=${JSON.stringify(startIds)}`)
        onCycleDetected({ workspaceId, startIds, txIdsInvolved: [] })
      } catch (err) {
        onError(err)
      }
    }
  }

  /** Post-materialization side effects shared by every drain path: invalidate
   *  cache + handles (writing the cache via the LWW gate — see
   *  `applySyncInvalidation`), then run cycle detection. */
  const applyOutcome = async (
    outcome: MaterializeOutcome,
  ): Promise<void> => {
    applySyncInvalidation(cache, handleStore, outcome.snapshots, rules())
    await runCycleScan(outcome.snapshots)
  }

  /** Materialize one bounded window + run its invalidation. The shared per-window
   *  step of both drain paths (queue-driven {@link drainQueueOnce} and
   *  workspace-rescan {@link materializeWorkspace}); they differ only in where
   *  the window's ids come from and what bookkeeping follows it. */
  const applyWindow = async (
    upserted: readonly string[],
    removed: readonly string[],
  ): Promise<MaterializeOutcome> => {
    const outcome = await materializeStagingRows(db, { upserted, removed }, deps)
    await applyOutcome(outcome)
    return outcome
  }

  const drainQueueOnce = async (): Promise<void> => {
    // Loop over the queue in bounded seq-ordered windows until it's empty, so a
    // large backlog never builds the whole working set in one in-memory pass /
    // one transaction. Each window commits independently (step 4), so the next
    // window — and any retry after a throw — resumes from the last consumed seq.
    for (;;) {
      if (disposed) throw disposedMidDrain()
      const rows = await db.getAll<QueueRow>(
        'SELECT seq, id, op FROM blocks_synced_changes ORDER BY seq LIMIT ?',
        [drainChunk],
      )
      if (rows.length === 0) return
      const maxSeq = rows[rows.length - 1]!.seq

      // Latest op per id within this window (rows are seq-ordered, so a later op
      // overwrites). Cross-window order holds too: windows run in seq order, so a
      // hot id's final state is set by whichever window holds its last change, and
      // re-materializing it in a later window is an idempotent LWW-gated write.
      const opById = new Map<string, 'upsert' | 'delete'>()
      for (const row of rows) opById.set(row.id, row.op)
      const upserted: string[] = []
      const removed: string[] = []
      for (const [id, op] of opById) (op === 'upsert' ? upserted : removed).push(id)

      await applyWindow(upserted, removed)

      // Consume only this window. Rows appended mid-drain have seq > maxSeq and
      // survive for a later window. Done last so a throw above leaves this window
      // queued (prior committed windows are not rolled back).
      await db.execute('DELETE FROM blocks_synced_changes WHERE seq <= ?', [maxSeq])

      // A short final window means the queue is drained; stop without an extra
      // empty read. (Rows arriving after this still re-trigger via onChange.)
      if (rows.length < drainChunk) return
    }
  }

  const materializeWorkspace = async (
    workspaceId: string,
    scope: RematerializeScope,
  ): Promise<RematerializeReport> => {
    if (disposed) throw disposedMidDrain()
    // The id set is read ONCE, before the first window. A delivery that lands
    // mid-pass is therefore not in it — correctly: that one is in the QUEUE,
    // which the queue drain owns, and picking it up here would mean a pass
    // whose end depends on the sync stream going quiet.
    const ids = (await db.getAll<{ id: string }>(
      scope === 'unapplied'
        ? WORKSPACE_UNAPPLIED_IDS_SQL
        : 'SELECT id FROM blocks_synced WHERE workspace_id = ? ORDER BY id',
      [workspaceId],
    )).map(row => row.id)
    const totals = {
      applied: 0, deferred: 0, skippedStale: 0, quarantined: 0, resolved: 0,
    }
    // Materialize in the same bounded windows as drainQueueOnce. A workspace
    // that synced while still unpinned (fresh-device initial sync: every row
    // defers and drainQueueOnce consumes its queue signal) can strand hundreds
    // of thousands of staged rows that only this re-pass recovers. Doing it in
    // one materializeStagingRows call would build the whole working set in
    // memory and wrap every upsert in a single transaction — the freeze a real
    // client hit on a 320k workspace, which then rolled back ALL progress when
    // interrupted. Independently-committed windows keep memory flat and let a
    // re-invocation resume (already-materialized rows LWW-skip next pass).
    for (let i = 0; i < ids.length; i += drainChunk) {
      if (disposed) throw disposedMidDrain()
      const outcome = await applyWindow(ids.slice(i, i + drainChunk), [])
      totals.applied += outcome.applied.length
      totals.deferred += outcome.deferred.length
      totals.skippedStale += outcome.skippedStale.length
      totals.quarantined += outcome.quarantined.length
      totals.resolved += outcome.resolved.length
    }
    return { scope, scanned: ids.length, ...totals }
  }

  // Serialize all work on one chain so drains never overlap and flush() awaits
  // everything enqueued before it.
  //
  // The returned promise REJECTS when the unit did not finish — reporting
  // through `onError` is not enough, because callers award success to this
  // promise: the key gate opens the workspace on it, and `runReconcileRescan`
  // writes its once-per-(workspace, client) marker on it. Resolving after a
  // throw or a teardown therefore retires the recovery path for a workspace
  // that is still only partly materialized, silently and one-way — the failure
  // both of those call sites already say in comments they are guarding against
  // (km-fsxp).
  //
  // The SPINE is a separate promise that never rejects. It is what keeps a
  // failed unit from wedging every later drain, and — because it always
  // attaches a rejection handler — what makes an unawaited `flush()` safe.
  const enqueue = <T>(work: () => Promise<T>): Promise<T> => {
    const done = chain.then(async () => {
      // ONE catch for both disposal checks — the one here and the loop-top ones
      // inside the drains. Written as two paths it was asymmetric: an
      // already-running multi-window drain (the realistic tab close) reported
      // teardown through `onError` while a not-yet-started one did not.
      try {
        if (disposed) throw disposedMidDrain()
        return await work()
      } catch (err) {
        if (!isDisposedMidDrain(err)) onError(err)
        throw err
      }
    })
    chain = done.then(() => {}, () => {})
    return done
  }

  const flush = (): Promise<void> => enqueue(drainQueueOnce)
  const drainWorkspace = (
    workspaceId: string,
    scope: RematerializeScope = 'all',
  ): Promise<RematerializeReport> => {
    // Counted from ENQUEUE rather than from the first window: a rescan waiting
    // its turn on the chain will still rewrite `blocks` with nothing in the
    // queue to show for it, which is the whole blindness. Decremented off the
    // promise, which settles on every exit including the disposed one, so the
    // count cannot leak; the derived promise gets its own handler because
    // `done` alone is what we hand back.
    //
    // The narrower `unapplied` scope is flagged the same way. It writes fewer
    // rows, not none — and a reader that saw no rescan in flight while one is
    // rewriting `blocks` is the exact blindness this counter exists to close.
    const bump = (by: number) =>
      workspaceRescans.set(workspaceId, (workspaceRescans.get(workspaceId) ?? 0) + by)
    bump(1)
    const done = enqueue(() => materializeWorkspace(workspaceId, scope))
    void done.finally(() => bump(-1)).catch(() => {})
    return done
  }

  // Subscribe first, then drain once: the subscription catches future appends,
  // and the initial drain catches rows already queued — including any that
  // landed while the observer was down (durable queue). Both serialize, and
  // the drain is idempotent, so the overlap is harmless.
  unsubscribe = db.onChange(
    {
      onChange: () => { void flush() },
      onError,
    },
    { tables: ['blocks_synced_changes'], throttleMs },
  )
  void flush()

  return {
    flush,
    drainWorkspace,
    isRematerializingWorkspace: (workspaceId: string) =>
      (workspaceRescans.get(workspaceId) ?? 0) > 0,
    dispose() {
      if (disposed) return
      disposed = true
      unsubscribe?.()
      unsubscribe = null
    },
  }
}
