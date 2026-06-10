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
 * invalidations) and `flush()` is a real settle barrier for tests.
 *
 * `drainWorkspace` re-materializes a workspace's staged rows directly from
 * `blocks_synced` (not the queue) — for when a workspace becomes
 * materializable without a staging change: a WK paste (deferred e2ee rows) or
 * a plaintext confirmation (§8 flows call it).
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
import type { ReconcileMode } from './reconcile.js'
import {
  applySyncInvalidation,
  type SyncCache,
  type SyncInvalidationTarget,
} from './invalidate.js'

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

export interface BlocksSyncedObserver {
  /** Drain the pending queue once. Awaitable settle barrier (awaits every
   *  drain enqueued before it). */
  flush(): Promise<void>
  /** Re-materialize a workspace's staged rows after it becomes materializable
   *  (WK paste / plaintext confirm). Reads `blocks_synced` directly. Uses the
   *  strict reconcile gate (steady-state semantics). */
  drainWorkspace(workspaceId: string): Promise<void>
  /** One-time recovery rescan: like {@link drainWorkspace}, but runs the gate
   *  in `healing` mode so a pre-provenance shadow (a real-user-stamped default
   *  that the strict gate would protect) still yields to the server. Used by
   *  `Repo.scheduleReconcileRescan`. */
  healWorkspace(workspaceId: string): Promise<void>
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

  /** Post-materialization side effects shared by both drain paths: invalidate
   *  cache + handles (one LWW gate), then run cycle detection. */
  const applyOutcome = async (outcome: MaterializeOutcome): Promise<void> => {
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
    gateMode: ReconcileMode = 'strict',
  ): Promise<void> => {
    const outcome = await materializeStagingRows(db, { upserted, removed }, deps, { gateMode })
    await applyOutcome(outcome)
  }

  const drainQueueOnce = async (): Promise<void> => {
    // Loop over the queue in bounded seq-ordered windows until it's empty, so a
    // large backlog never builds the whole working set in one in-memory pass /
    // one transaction. Each window commits independently (step 4), so the next
    // window — and any retry after a throw — resumes from the last consumed seq.
    for (;;) {
      if (disposed) return
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
    gateMode: ReconcileMode = 'strict',
  ): Promise<void> => {
    if (disposed) return
    const ids = (await db.getAll<{ id: string }>(
      'SELECT id FROM blocks_synced WHERE workspace_id = ? ORDER BY id',
      [workspaceId],
    )).map(row => row.id)
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
      if (disposed) return
      await applyWindow(ids.slice(i, i + drainChunk), [], gateMode)
    }
  }

  // Serialize all work on one chain so drains never overlap and flush() awaits
  // everything enqueued before it. A failed unit reports and doesn't break the
  // chain (the `, () => {}` rejection handler keeps it alive).
  const enqueue = (work: () => Promise<void>): Promise<void> => {
    const next = chain.then(async () => {
      if (disposed) return
      try {
        await work()
      } catch (err) {
        onError(err)
      }
    }, () => {})
    chain = next
    return next
  }

  const flush = (): Promise<void> => enqueue(drainQueueOnce)
  const drainWorkspace = (workspaceId: string): Promise<void> =>
    enqueue(() => materializeWorkspace(workspaceId, 'strict'))
  const healWorkspace = (workspaceId: string): Promise<void> =>
    enqueue(() => materializeWorkspace(workspaceId, 'healing'))

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
    healWorkspace,
    dispose() {
      if (disposed) return
      disposed = true
      unsubscribe?.()
      unsubscribe = null
    },
  }
}
