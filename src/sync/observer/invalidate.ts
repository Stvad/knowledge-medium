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
 * `updated_at` / provenance to decide what to write to disk, so `snapshots`
 * only contains rows that won that gate. The cache write here is
 * `applyFromSync(after, before)`: it takes the observer's row when the cache
 * still matches the pre-write disk row (`before`) — healing the
 * deterministic-id shadow LIVE even when `after` is older-stamped — and
 * otherwise falls back to the in-memory LWW so a newer local edit is never
 * clobbered. A row the cache rejects produced no user-visible change, so (as in
 * the old tail) it contributes no invalidation, avoiding the re-read flicker
 * that waking handles to stale SQL would cause. Replay deliveries are already
 * skip-staled at the disk gate, so they never reach this force path.
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
export type SyncCache = Pick<BlockCache, 'applyFromSync' | 'markMissing'>

/**
 * Reflect a materialization pass's `snapshots` into the cache and notify
 * handles. Updates each row's cache snapshot (`applyFromSync` for an apply,
 * `markMissing` for a removal) and, for the rows the cache accepted, emits one
 * `ChangeNotification` (rowIds / parentIds / workspaceIds / plugin).
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
    // Removal branch: mark the id confirmed-missing rather than merely
    // evicting its snapshot. A lean childIds handle can cache membership
    // without ever hydrating the row into BlockCache, so a sync-applied
    // hard-delete must still count as accepted on the first missing
    // transition (markMissing returns true even with no prior snapshot) and
    // invalidate its parent-edge deps. Mirrors the fast path's post-commit
    // cache walk (commitPipeline step 6) and the retired tail's delete branch.
    const changed = snap.after
      ? cache.applyFromSync(snap.after, snap.before)
      : cache.markMissing(id)
    if (changed) accepted.set(id, snap)
  }
  if (accepted.size === 0) return null
  const notification = snapshotsToChangeNotification(accepted, invalidationRules)
  handleStore.invalidate(notification)
  return notification
}
