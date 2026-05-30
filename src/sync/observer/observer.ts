/**
 * Layout B observer — the driver (design doc §9.2).
 *
 * Ties the change-capture queue, the materialization core, and the
 * invalidation relocation into the running sync seam. PowerSync writes
 * downloaded rows into the raw `blocks_synced` staging table; AFTER triggers
 * append `(seq, id, op)` to `blocks_synced_changes`; this driver drains that
 * log and turns each change into the app-visible plaintext `blocks` table.
 *
 * DRAIN (race- and failure-safe, the row_events watermark pattern):
 *   1. read the queue up to MAX(seq),
 *   2. dedup per id (latest op wins — a hot row materializes once per batch),
 *   3. `materializeStagingRows` (decrypt/copy/defer/skip/delete) +
 *      `applySyncInvalidation` (cache + handles, one LWW gate),
 *   4. `DELETE … WHERE seq <= <that max>`.
 * A delivery that lands mid-drain gets a higher seq, so step 4 can't drop it;
 * if any step throws, the delete is skipped and the rows retry next tick.
 *
 * Drains serialize on a single promise chain, so two never overlap (duplicate
 * invalidations) and `flush()` is a real settle barrier for tests.
 *
 * `drainWorkspace` re-materializes a workspace's staged rows directly from
 * `blocks_synced` (not the queue) — for when a workspace becomes
 * materializable without a staging change: a WK paste (deferred e2ee rows) or
 * a plaintext confirmation (§8 flows call it).
 *
 * NOTE: the §4.7 cycle-scan telemetry that lived in rowEventsTail is not yet
 * relocated here — it lands in a follow-up before the cutover removes the tail.
 */

import type { PowerSyncDb } from '@/data/internals/commitPipeline.js'
import type { InvalidationRule } from '@/data/invalidation.js'
import { materializeStagingRows, type MaterializeDeps } from './materialize.js'
import {
  applySyncInvalidation,
  type SyncCache,
  type SyncInvalidationTarget,
} from './invalidate.js'

/** Drain-throttle window (ms). Matches the row_events tail default — coalesces
 *  sync-burst arrivals into one batched drain. */
const DEFAULT_THROTTLE_MS = 100

export interface BlocksSyncedObserverArgs {
  readonly db: PowerSyncDb
  readonly cache: SyncCache
  readonly handleStore: SyncInvalidationTarget
  readonly deps: MaterializeDeps
  /** Plugin invalidation rules, read fresh each drain (plugins can register
   *  after the observer starts). */
  readonly getInvalidationRules?: () => readonly InvalidationRule[]
  readonly throttleMs?: number
  readonly onError?: (err: unknown) => void
}

export interface BlocksSyncedObserver {
  /** Drain the pending queue once. Awaitable settle barrier (awaits every
   *  drain enqueued before it). */
  flush(): Promise<void>
  /** Re-materialize a workspace's staged rows after it becomes materializable
   *  (WK paste / plaintext confirm). Reads `blocks_synced` directly. */
  drainWorkspace(workspaceId: string): Promise<void>
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

export const startBlocksSyncedObserver = (
  args: BlocksSyncedObserverArgs,
): BlocksSyncedObserver => {
  const { db, cache, handleStore, deps, getInvalidationRules } = args
  const throttleMs = args.throttleMs ?? DEFAULT_THROTTLE_MS
  const rules = (): readonly InvalidationRule[] => getInvalidationRules?.() ?? []
  const onError = args.onError ?? ((err: unknown) => {
    if (!isConnectionClosedError(err)) console.warn('[blocksSyncedObserver] drain error:', err)
  })

  let disposed = false
  let unsubscribe: (() => void) | null = null
  let chain: Promise<void> = Promise.resolve()

  const drainQueueOnce = async (): Promise<void> => {
    if (disposed) return
    const rows = await db.getAll<QueueRow>(
      'SELECT seq, id, op FROM blocks_synced_changes ORDER BY seq',
    )
    if (rows.length === 0) return
    const maxSeq = rows[rows.length - 1]!.seq

    // Latest op per id (rows are seq-ordered, so a later op overwrites).
    const opById = new Map<string, 'upsert' | 'delete'>()
    for (const row of rows) opById.set(row.id, row.op)
    const upserted: string[] = []
    const removed: string[] = []
    for (const [id, op] of opById) (op === 'upsert' ? upserted : removed).push(id)

    const outcome = await materializeStagingRows(db, { upserted, removed }, deps)
    applySyncInvalidation(cache, handleStore, outcome.snapshots, rules())

    // Consume only what we read. Rows appended mid-drain have seq > maxSeq and
    // survive for the next pass. Done last so a throw above leaves them queued.
    await db.execute('DELETE FROM blocks_synced_changes WHERE seq <= ?', [maxSeq])
  }

  const materializeWorkspace = async (workspaceId: string): Promise<void> => {
    if (disposed) return
    const ids = (await db.getAll<{ id: string }>(
      'SELECT id FROM blocks_synced WHERE workspace_id = ?',
      [workspaceId],
    )).map(row => row.id)
    if (ids.length === 0) return
    const outcome = await materializeStagingRows(db, { upserted: ids, removed: [] }, deps)
    applySyncInvalidation(cache, handleStore, outcome.snapshots, rules())
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
    enqueue(() => materializeWorkspace(workspaceId))

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
    dispose() {
      if (disposed) return
      disposed = true
      unsubscribe?.()
      unsubscribe = null
    },
  }
}
