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
 * rows that won that gate. The cache write here is `applyIfNewer(after,
 * 'sync')` — the in-memory LWW. It heals a 0-stamped pristine default LIVE for
 * free (any real server value out-stamps 0), while REJECTING an older-stamped
 * delivery over a newer local cache value.
 *
 * That reject is load-bearing: the disk gate is server-monotonic but
 * INDISCRIMINATE toward a strictly-newer local row (it applies an older server
 * row over a just-acked-not-yet-echoed real edit during a rescan's ack→echo
 * window — a transient disk revert the echo converges). Force-applying that
 * onto the cache would surface it as a new→old→new UI flash. Keeping the cache
 * LWW masks the transient: disk self-heals on the echo, and the rare legacy
 * NONZERO shadow heals on disk now + in the cache on the next reload. This is
 * the invariant commit cd8f87a9 established (force-heal only when the disk gate
 * protected real edits) — the gate is uniformly indiscriminate, so the cache is
 * uniformly LWW. A row the cache rejects produced no user-visible change, so it
 * contributes no invalidation, avoiding the re-read flicker that waking handles
 * to stale SQL would cause.
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
export type SyncCache = Pick<BlockCache, 'applyIfNewer' | 'markMissing'>

/**
 * Reflect a materialization pass's `snapshots` into the cache and notify
 * handles. Updates each row's cache snapshot (`applyIfNewer` for an apply,
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
    //
    // Apply branch is the in-memory LWW: heal a 0-stamped pristine default live
    // (server out-stamps 0) but reject an older delivery over a newer local
    // cache value, so a rescan's transient disk revert (ack→echo window) never
    // surfaces as a UI flash. `before` is unused now — the gate's decision is
    // already encoded in the disk write; the cache only guards re-read flicker.
    const changed = snap.after
      ? cache.applyIfNewer(snap.after, 'sync')
      : cache.markMissing(id)
    if (changed) accepted.set(id, snap)
  }
  if (accepted.size === 0) return null
  const notification = snapshotsToChangeNotification(accepted, invalidationRules)
  handleStore.invalidate(notification)
  return notification
}
