/**
 * Layout B observer — invalidation relocation (design doc §9.2).
 *
 * Under Layout B the observer is the single JS seam that applies every sync
 * write, so it invalidates DIRECTLY — subsuming the old `row_events` →
 * `rowEventsTail` round-trip. It already holds both sides of each change in
 * memory (the materialized `after`, and the pre-write `before` it reads for
 * the LWW gate), so it can feed them straight into the SAME helper the local
 * `repo.tx` fast path uses — `snapshotsToChangeNotification` — instead of
 * re-deriving them from a serialized audit row.
 *
 * One gate, not two: `materializeStagingRows` already consulted `ps_crud` /
 * `updated_at` to decide what to write to disk, so `snapshots` only contains
 * rows that won that gate. The remaining cache gate here is the in-memory LWW
 * (`applyIfNewer`), which also dedups fingerprint-identical re-deliveries — a
 * row the cache rejects produced no user-visible change, so (as in the old
 * tail) it contributes no invalidation, avoiding the re-read flicker that
 * waking handles to stale SQL would cause.
 */

import type { BlockCache } from '@/data/blockCache.js'
import {
  snapshotsToChangeNotification,
  type ChangeNotification,
} from '@/data/internals/handleStore.js'
import type { ChangeSnapshot, InvalidationRule } from '@/data/invalidation.js'
import type { SyncSnapshot } from './materialize.js'

/** The handle-invalidation surface the observer needs (a structural subset of
 *  `HandleStore`, so tests can pass a spy). */
export interface SyncInvalidationTarget {
  invalidate(change: ChangeNotification): void
}

/** The cache surface the observer writes through. */
export type SyncCache = Pick<BlockCache, 'applyIfNewer' | 'deleteSnapshot'>

/**
 * Reflect a materialization pass's `snapshots` into the cache and notify
 * handles. Updates each row's cache snapshot (`applyIfNewer('sync')` for an
 * apply, `deleteSnapshot` for a removal) and, for the rows the cache accepted,
 * emits one `ChangeNotification` (rowIds / parentIds / workspaceIds / plugin).
 *
 * Returns the notification that was dispatched, or null if every row was
 * rejected by the cache gate (nothing to notify).
 */
export const applySyncInvalidation = (
  cache: SyncCache,
  handleStore: SyncInvalidationTarget,
  snapshots: ReadonlyMap<string, SyncSnapshot>,
  invalidationRules: readonly InvalidationRule[] = [],
): ChangeNotification | null => {
  const accepted = new Map<string, ChangeSnapshot>()
  for (const [id, snap] of snapshots) {
    const changed = snap.after
      ? cache.applyIfNewer(snap.after, 'sync')
      : cache.deleteSnapshot(id)
    if (changed) accepted.set(id, snap)
  }
  if (accepted.size === 0) return null
  const notification = snapshotsToChangeNotification(accepted, invalidationRules)
  handleStore.invalidate(notification)
  return notification
}
