/**
 * row_events tail — sync-applied invalidation path (spec §9.3 path 2).
 *
 * Local writes go through `repo.tx`, which fires the engine's fast-path
 * `handleStore.invalidate(...)` and updates the cache directly. PowerSync
 * sync-applied writes land in SQLite via the CRUD-apply path, BYPASSING
 * `repo.tx` — they never set `tx_context.source`, so the `row_events`
 * trigger COALESCEs source to `'sync'`.
 *
 * This tail subscribes to the `row_events` table, filters to
 * `source = 'sync'` (avoiding overlap with the engine fast-path), and:
 *
 *   - Reads new rows since the last consumed `id`.
 *   - Updates the BlockCache with the after_json snapshot (or evicts
 *     on hard-delete) so Block facades subscribed via cache.subscribe
 *     reflect remote changes — without this, sync writes are invisible
 *     to UI consumers that don't go through a collection handle.
 *   - Auto-clears `allChildrenLoaded(parentId)` for any sync-applied
 *     write whose before_parent or after_parent matches a tracked
 *     parent (children-of marker becomes stale; the matching
 *     `repo.children(parentId)` handle re-resolves and re-sets the
 *     marker via its parent-edge dep below).
 *   - Calls `handleStore.invalidate(...)` with the same `ChangeNotification`
 *     shape the fast path uses, so collection handles re-resolve.
 *
 * Throttling: db.onChange's `throttleMs` coalesces sync-burst arrivals
 * into batched processing. 100ms is the spec's recommendation (§9.3).
 *
 * The tail is a single subscription on the `row_events` table —
 * regardless of how many handles exist, only one query runs per
 * throttle window, and the dep-matching walk inside HandleStore is
 * O(handles × deps).
 */

import type { BlockData } from '@/data/api'
import type { BlockCache } from '@/data/blockCache'
import type { PowerSyncDb } from './commitPipeline'
import type { ChangeNotification, HandleStore } from './handleStore'

/** Shape of a single `row_events` row we care about. */
interface RowEventRow {
  id: number
  block_id: string
  kind: string // 'insert' | 'update' | 'delete'
  before_json: string | null
  after_json: string | null
}

/** Row_events tail throttle window in ms (spec §9.3, §16.13). */
const DEFAULT_THROTTLE_MS = 100

export interface RowEventsTailOptions {
  throttleMs?: number
  /** Optional override for the initial high-watermark query. Tests inject
   *  this to start the tail from id=0 (consume historical rows too). */
  initialLastId?: number
  onError?: (err: unknown) => void
}

export interface RowEventsTail {
  /** Stop the subscription. Idempotent. */
  dispose(): void
  /** Run one tail-pass synchronously. Used by tests to flush without
   *  waiting on the throttle window. */
  flush(): Promise<void>
  /** The id of the most recent row we consumed. Useful for tests. */
  lastId(): number
}

/** Start the tail subscription. Returns a handle for disposal + manual
 *  flush. The async initialization runs in the background; the returned
 *  object is usable immediately (`flush()` will await initialization). */
export const startRowEventsTail = (args: {
  db: PowerSyncDb
  cache: BlockCache
  handleStore: HandleStore
  options?: RowEventsTailOptions
}): RowEventsTail => {
  const { db, cache, handleStore, options } = args
  const throttleMs = options?.throttleMs ?? DEFAULT_THROTTLE_MS
  const onError = options?.onError ?? ((err) => {
    console.warn('[Repo] row_events tail error:', err)
  })

  let lastId = 0
  let disposed = false
  let unsubscribe: (() => void) | null = null

  const ready = (async () => {
    if (options?.initialLastId !== undefined) {
      lastId = options.initialLastId
    } else {
      // Start at the current MAX(id) so we don't replay historical rows
      // (those are already represented in the persisted state). Future
      // sync arrivals get id > lastId and are picked up.
      const row = await db.getOptional<{ maxId: number | null }>(
        `SELECT MAX(id) AS maxId FROM row_events`,
      )
      lastId = row?.maxId ?? 0
    }
  })().catch((err) => { onError(err) })

  const processOnce = async (): Promise<void> => {
    if (disposed) return
    await ready
    const rows = await db.getAll<RowEventRow>(
      `SELECT id, block_id, kind, before_json, after_json
         FROM row_events
        WHERE id > ? AND source = 'sync'
        ORDER BY id ASC`,
      [lastId],
    )
    if (rows.length === 0) return

    const rowIds = new Set<string>()
    const parentIds = new Set<string>()
    const workspaceIds = new Set<string>()

    for (const r of rows) {
      lastId = Math.max(lastId, r.id)
      rowIds.add(r.block_id)

      const before = r.before_json
        ? safeParseBlockData(r.before_json)
        : null
      const after = r.after_json
        ? safeParseBlockData(r.after_json)
        : null

      if (before?.workspaceId) workspaceIds.add(before.workspaceId)
      if (after?.workspaceId) workspaceIds.add(after.workspaceId)

      // Membership-change rules — same as snapshotsToChangeNotification
      // in the fast path; kept inline because we don't have synthetic
      // SnapshotEntry shapes here (would force allocations + a parsing
      // detour just to call the helper).
      const beforeParent = before?.parentId ?? null
      const afterParent = after?.parentId ?? null
      const beforeLive = !!before && !before.deleted
      const afterLive = !!after && !after.deleted

      if (!beforeLive && afterLive && afterParent !== null) {
        parentIds.add(afterParent)
      } else if (beforeLive && !afterLive && beforeParent !== null) {
        parentIds.add(beforeParent)
      } else if (beforeLive && afterLive && beforeParent !== afterParent) {
        if (beforeParent !== null) parentIds.add(beforeParent)
        if (afterParent !== null) parentIds.add(afterParent)
      }

      // Auto-clear allChildrenLoaded markers (spec §5.2): any parent
      // gaining or losing a child via sync needs its marker cleared
      // so `block.childIds` doesn't lie. Both before and after parents
      // are touched defensively — children-of correctness wins over a
      // marginally redundant clear.
      if (beforeParent !== null) cache.clearChildrenLoaded(beforeParent)
      if (afterParent !== null) cache.clearChildrenLoaded(afterParent)

      // Cache update: sync writes don't go through commitPipeline's
      // post-commit cache walk. Without this, Block.subscribe listeners
      // wouldn't fire on remote changes.
      if (after) {
        cache.setSnapshot(after as BlockData)
      } else {
        // No after_json (hard delete via row_events kind='delete'?).
        // SQLite blocks rows are soft-deleted (the column is `deleted=1`)
        // so `after` is normally non-null with `deleted: true` — this
        // branch is the safety net for any edge case where the trigger
        // fires without an after row.
        cache.deleteSnapshot(r.block_id)
      }
    }

    const notification: ChangeNotification = { rowIds, parentIds, workspaceIds }
    handleStore.invalidate(notification)
  }

  // Subscribe to the row_events table. The throttle coalesces burst
  // arrivals into one tail-pass per window. We don't pass-through the
  // promise — onChange's contract is fire-and-forget; we just log
  // errors via onError.
  unsubscribe = db.onChange(
    {
      onChange: () => {
        void processOnce().catch((err) => onError(err))
      },
      onError: (err) => onError(err),
    },
    { tables: ['row_events'], throttleMs },
  )

  return {
    dispose() {
      if (disposed) return
      disposed = true
      if (unsubscribe) {
        unsubscribe()
        unsubscribe = null
      }
    },
    flush: () => processOnce(),
    lastId: () => lastId,
  }
}

const safeParseBlockData = (json: string): BlockData | null => {
  try {
    return JSON.parse(json) as BlockData
  } catch {
    return null
  }
}
