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
 *   - Calls `handleStore.invalidate(...)` with a `ChangeNotification`
 *     that lists `rowIds` + `parentIds` + `workspaceIds` so collection
 *     handles re-resolve. `parentIds` covers both before- and after-
 *     parents of sync-applied edge changes, matching the `parent-edge`
 *     dep declared by `repo.children` / `repo.childIds`.
 *
 * Throttling: db.onChange's `throttleMs` coalesces sync-burst arrivals
 * into batched processing. 100ms is the spec's recommendation (§9.3).
 *
 * The tail is a single subscription on the `row_events` table —
 * regardless of how many handles exist, only one query runs per
 * throttle window, and the dep-matching walk inside HandleStore is
 * O(handles × deps).
 */

import type { BlockData, CycleDetectedEvent } from '@/data/api'
import type { BlockCache } from '@/data/blockCache'
import type { PowerSyncDb } from './commitPipeline'
import type { ChangeNotification, HandleStore } from './handleStore'
import { cycleScanSql } from './treeQueries'
import {
  createPluginInvalidationEmitter,
  type InvalidationRule,
  type MutablePluginInvalidationMap,
} from '@/data/invalidation.ts'

/** Shape of a single `row_events` row we care about. */
interface RowEventRow {
  id: number
  block_id: string
  kind: string // 'insert' | 'update' | 'delete'
  before_json: string | null
  after_json: string | null
  tx_id: string | null
}

/** Row_events tail throttle window in ms (spec §9.3, §16.13). */
const DEFAULT_THROTTLE_MS = 100

export interface RowEventsTailOptions {
  throttleMs?: number
  /** Optional override for the initial high-watermark query. Tests inject
   *  this to start the tail from id=0 (consume historical rows too). */
  initialLastId?: number
  onError?: (err: unknown) => void
  /** Fired once per drain pass when the bounded cycle scan finds at
   *  least one affected id closing back on itself. One event per
   *  workspace involved (single-workspace per cycle by construction
   *  — server FK + invariant trigger keep parent_id mutations within
   *  a workspace). Spec §4.7. */
  onCycleDetected?: (event: CycleDetectedEvent) => void
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
  getInvalidationRules?: () => readonly InvalidationRule[]
  options?: RowEventsTailOptions
}): RowEventsTail => {
  const { db, cache, handleStore, getInvalidationRules, options } = args
  const throttleMs = options?.throttleMs ?? DEFAULT_THROTTLE_MS
  const onError = options?.onError ?? ((err) => {
    console.warn('[Repo] row_events tail error:', err)
  })
  const onCycleDetected = options?.onCycleDetected

  let lastId = 0
  let disposed = false
  let unsubscribe: (() => void) | null = null
  let initComplete = false

  // A drain in flight when the underlying PowerSync DB closes (test
  // teardown closing the db without stopping the tail; production
  // tab-close / signOut) rejects from `db.getAll(...)` with
  // ConnectionClosedError. That's a benign shutdown signal — there's
  // no longer anyone to invalidate handles for. Auto-dispose so the
  // chained drains stop, and skip the onError call so we don't spam
  // the test reporter.
  const reportError = (err: unknown): void => {
    if (disposed || isConnectionClosedError(err)) {
      disposed = true
      if (unsubscribe) {
        unsubscribe()
        unsubscribe = null
      }
      return
    }
    onError(err)
  }

  /** Inner drain — reads + processes rows with id > lastId. Used by
   *  both the init-time catch-up read AND the subscription's onChange
   *  handler. Does NOT await `ready` (callers ensure ordering). */
  const drain = async (): Promise<void> => {
    if (disposed) return
    const rows = await db.getAll<RowEventRow>(
      `SELECT id, block_id, kind, before_json, after_json, tx_id
         FROM row_events
        WHERE id > ? AND source = 'sync'
        ORDER BY id ASC`,
      [lastId],
    )
    if (rows.length === 0) return

    const rowIds = new Set<string>()
    const parentIds = new Set<string>()
    const workspaceIds = new Set<string>()
    const pluginInvalidations: MutablePluginInvalidationMap = new Map()
    const emitPluginInvalidation = createPluginInvalidationEmitter(pluginInvalidations)
    const invalidationRules = getInvalidationRules?.() ?? []

    /** Per-workspace bookkeeping for the §4.7 cycle scan. We only need
     *  to scan rows whose parent_id changed (a fresh insert with no
     *  descendants can't close a loop on its own; a content-only edit
     *  doesn't change reachability). The scan itself is bounded to
     *  these starting ids — cheap regardless of DB size. */
    const cycleAffectedByWs = new Map<string, Set<string>>()
    const cycleTxIdsByWs = new Map<string, Set<string>>()

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

      for (const rule of invalidationRules) {
        rule.collectFromRowEvent?.({
          blockId: r.block_id,
          kind: r.kind,
          before,
          after,
        }, emitPluginInvalidation)
      }

      // Cycle-scan candidate selection: live row whose parent_id
      // actually moved. Inserts and deletes can't close cycles on
      // their own — only an UPDATE that re-points an existing chain
      // can. The block's *current* workspace is what matters for the
      // event grouping (post-write reachability is what we're scanning).
      if (
        onCycleDetected
        && beforeLive
        && afterLive
        && beforeParent !== afterParent
        && after?.workspaceId
      ) {
        let bucket = cycleAffectedByWs.get(after.workspaceId)
        if (!bucket) {
          bucket = new Set()
          cycleAffectedByWs.set(after.workspaceId, bucket)
        }
        bucket.add(r.block_id)
        if (r.tx_id) {
          let txBucket = cycleTxIdsByWs.get(after.workspaceId)
          if (!txBucket) {
            txBucket = new Set()
            cycleTxIdsByWs.set(after.workspaceId, txBucket)
          }
          txBucket.add(r.tx_id)
        }
      }

      // Cache update: sync writes don't go through commitPipeline's
      // post-commit cache walk. Without this, Block.subscribe listeners
      // wouldn't fire on remote changes. Routed through
      // `applySyncSnapshot` so a stale `updated_at` (PowerSync delivering
      // server-state-at-time-T while the local cache has advanced via the
      // fast path) is rejected — otherwise the editor sees its own older
      // echoes clobber the live snapshot mid-typing.
      if (after) {
        cache.applySyncSnapshot(after as BlockData)
      } else {
        // No after_json (hard delete via row_events kind='delete'?).
        // SQLite blocks rows are soft-deleted (the column is `deleted=1`)
        // so `after` is normally non-null with `deleted: true` — this
        // branch is the safety net for any edge case where the trigger
        // fires without an after row.
        cache.deleteSnapshot(r.block_id)
      }
    }

    // §4.7 detection-only telemetry. Run the bounded scan once per
    // workspace whose sync-applied parent_id mutations might have
    // closed a loop. The scan is engine-truncation-safe (depth-100 +
    // visited-id guard inline) so even pathological data can't hang
    // it. Emit one event per workspace with non-empty results.
    if (onCycleDetected && cycleAffectedByWs.size > 0) {
      for (const [workspaceId, ids] of cycleAffectedByWs) {
        const idList = Array.from(ids)
        try {
          const sql = cycleScanSql(idList.length)
          const hits = await db.getAll<{ start_id: string }>(sql, idList)
          if (hits.length === 0) continue
          const startIds = hits.map(h => h.start_id).sort()
          const txIdsInvolved = Array.from(
            cycleTxIdsByWs.get(workspaceId) ?? [],
          ).sort()
          console.warn(
            `[Repo] cycleDetected ws=${workspaceId} startIds=${JSON.stringify(startIds)}`,
          )
          onCycleDetected({ workspaceId, startIds, txIdsInvolved })
        } catch (err) {
          // Don't let a scan failure abort handle invalidation below
          // — surface via reportError and continue.
          reportError(err)
        }
      }
    }

    // Children-set changes propagate via `handleStore.invalidate` below
    // — `repo.children(parentId)` / `repo.childIds(parentId)` declare
    // a `parent-edge` dep, so a parent_id landing in `parentIds` here
    // triggers re-resolve on the matching handle. No cache-level
    // marker to clear (collection state lives on the handle).
    //
    // `tables: ['blocks']` mirrors the fast path — query handles that
    // declare a coarse `{kind:'table', table:'blocks'}` dep need this
    // notification to re-run on sync-applied writes (without it, the
    // table-coarse fallback never fires from the sync path; reviewer P2).
    const notification: ChangeNotification = {
      rowIds,
      parentIds,
      workspaceIds,
      tables: new Set(['blocks']),
      plugin: pluginInvalidations.size > 0 ? pluginInvalidations : undefined,
    }
    handleStore.invalidate(notification)
  }

  // Init flow that closes the row_events tail gap (spec §9.3, §16.13;
  // reviewer P2 — PowerSync's onChange is trailing-throttled, so a row
  // that lands while a post-subscription MAX query is in flight can be
  // both included in the MAX result AND not yet delivered to the
  // throttled callback; lastId would skip past it and the eventual
  // callback would also drain id > lastId and find nothing):
  //
  //   1. READ MAX(id) → M (pre-subscription watermark). Captures every
  //      row that exists before the subscription is in place.
  //   2. SET lastId = M.
  //   3. SUBSCRIBE. From this point, future commits fire the
  //      trailing-throttled onChange callback.
  //   4. DRAIN id > M. Catches rows committed between (1) and (3) —
  //      they're in the DB, but the subscription wouldn't deliver an
  //      event for a row that committed before it was registered — and
  //      rows committed between (3) and the drain itself (the throttled
  //      callback would fire later anyway; draining now just picks them
  //      up early, and drain is idempotent because lastId is monotonic).
  //   5. FLIP initComplete so subsequent onChange events route to
  //      processOnce.
  lastId = options?.initialLastId ?? 0

  // `processOnce` and `ready` reference each other lazily: processOnce
  // awaits `ready` inside its body, and the onChange callback in
  // `ready`'s IIFE calls processOnce. Both references resolve at call
  // time (after init completes — see `initComplete` gate), by which
  // point both bindings are initialized.
  //
  // Drains serialize via `chain`: each `processOnce` enqueues its drain
  // at the tail of a single promise chain, so two drains never run
  // concurrently. Two reasons matter:
  //
  //   1. Concurrent drains race on `lastId`. Without serialization, a
  //      drain that reads `id > lastId` before the prior drain bumps
  //      `lastId` ends up processing the same row twice — duplicate
  //      cache writes, duplicate handle invalidations, duplicate cycle
  //      events.
  //
  //   2. `flush()` (used by tests, undo replay, reviewer P2 race
  //      coverage) needs to be a real settle barrier. Returning the
  //      shared chain promise means awaiting `flush()` awaits every
  //      drain enqueued before it — including any onChange-triggered
  //      drains that fired during the caller's preceding writes. The
  //      pre-serialization shape returned a fresh `processOnce` promise
  //      that did not wait on those, so `await flush()` could resolve
  //      with prior drains' work still in flight, and a sync-applied
  //      cycle event could fire after the test's `expect`.
  let chain: Promise<void> = Promise.resolve()
  const processOnce = (): Promise<void> => {
    const next = chain.then(async () => {
      if (disposed) return
      await ready
      if (disposed) return
      await drain()
    }, () => {})
    chain = next
    return next
  }

  const ready = (async (): Promise<void> => {
    if (disposed) return
    if (options?.initialLastId === undefined) {
      const row = await db.getOptional<{ maxId: number | null }>(
        `SELECT MAX(id) AS maxId FROM row_events`,
      )
      if (disposed) return
      lastId = row?.maxId ?? 0
    }
    if (disposed) return
    unsubscribe = db.onChange(
      {
        onChange: () => {
          if (!initComplete) {
            // The post-subscribe drain below will pick up any row that
            // committed in this window, so we drop these events on the
            // floor — the subsequent throttled callback (after init)
            // will re-drain anything that arrived later.
            return
          }
          void processOnce().catch((err) => reportError(err))
        },
        onError: (err) => reportError(err),
      },
      { tables: ['row_events'], throttleMs },
    )
    if (disposed) {
      unsubscribe?.()
      unsubscribe = null
      return
    }
    await drain()
    initComplete = true
  })().catch((err) => { reportError(err) })

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

/** PowerSync raises this from queued `db.getAll` / `db.getOptional`
 *  calls when the underlying connection closes mid-flight. Identified
 *  by name to avoid taking a runtime dep on `@powersync/common` here
 *  (the tail's `PowerSyncDb` type is structural). */
const isConnectionClosedError = (err: unknown): boolean => {
  if (!err || typeof err !== 'object') return false
  const name = (err as { name?: unknown }).name
  return name === 'ConnectionClosedError'
}

const safeParseBlockData = (json: string): BlockData | null => {
  try {
    return JSON.parse(json) as BlockData
  } catch {
    return null
  }
}
