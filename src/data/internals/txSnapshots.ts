/**
 * Per-tx snapshots map. The single source of "what this tx wrote" — used
 * by the commit pipeline (§10) for cache update + handle diffing + undo
 * entry, and by `tx.peek` for sync within-tx reads.
 *
 * Capture rule: on the first touch of an id during a tx, the engine
 * SELECTs the current row (`before`). Subsequent writes for the same id
 * update `after`. On rollback the map is discarded — there is nothing to
 * revert because the shared cache was never mutated mid-tx (v4.24).
 */

import type { BlockData } from '@/data/api'

export interface SnapshotEntry {
  /** State at first touch. `null` means no row existed when this tx
   *  first looked at the id (i.e. the tx is creating it). */
  before: BlockData | null
  /** State after this tx's most recent write. `null` means hard-delete
   *  (not used by tx primitives in v1; soft-delete keeps the row with
   *  `deleted: true`). */
  after: BlockData | null
}

/** Tx-private snapshots map. One per `repo.tx` invocation. */
export type SnapshotsMap = Map<string, SnapshotEntry>

export const newSnapshotsMap = (): SnapshotsMap => new Map()

/** Record a write. If this is the first touch of `id`, `before` is the
 *  passed-in current state (the engine SELECTed it just before issuing
 *  the write). On subsequent writes, `before` is preserved and only
 *  `after` is updated. */
export const recordWrite = (
  snapshots: SnapshotsMap,
  id: string,
  before: BlockData | null,
  after: BlockData | null,
): void => {
  const existing = snapshots.get(id)
  if (existing) {
    snapshots.set(id, {before: existing.before, after})
  } else {
    snapshots.set(id, {before, after})
  }
}

/** Look up an own-write for a given id. Used by `tx.peek` to see this
 *  tx's pending writes before the cache. */
export const peekSnapshot = (
  snapshots: SnapshotsMap,
  id: string,
): BlockData | null | undefined => {
  const entry = snapshots.get(id)
  return entry === undefined ? undefined : entry.after
}
