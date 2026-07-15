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

/** Fold a later tx's snapshots into an earlier one, in place — the
 *  cross-tx analog of {@link recordWrite}'s within-tx rule: per block,
 *  keep the EARLIEST `before` (target's, when both touched the id) and
 *  take the LATEST `after` (incoming's). Used by `UndoManager.record`
 *  to merge same-group entries (issue #306) so one undo entry reverts
 *  a whole multi-tx composite operation. */
export const mergeSnapshotsInto = (
  target: SnapshotsMap,
  incoming: SnapshotsMap,
): void => {
  // Each incoming snapshot replays as a "write" against the target map,
  // so the fold rule lives in exactly one place: recordWrite.
  for (const [id, snap] of incoming) {
    recordWrite(target, id, snap.before, snap.after)
  }
}

/** Order snapshot targets for undo/redo replay so the row-level
 *  parent-liveness trigger passes at every intermediate statement, not
 *  just in the end state. The end state (all rows at `before`, resp.
 *  `after`) is a previously-observed valid state, but `applyRaw` writes
 *  one row at a time and `blocks_parent_not_deleted_check_update` sees
 *  each intermediate state — so a live-target child must be applied
 *  AFTER the entry-internal parent it lands under is itself live.
 *
 *  Ordering rule: live-target rows first, parents before children
 *  (topological over the target forest, restricted to ids in the
 *  entry); tombstone/remove targets last (their writes have
 *  `NEW.deleted = 1` or don't touch `parent_id`, so the trigger's WHEN
 *  clause exempts them). A live-target row whose parent is outside the
 *  entry needs no ordering: the parent was live in the target state
 *  and untouched by this tx, so it is live now.
 *
 *  Before this, safety leaned on each mutator's first-touch order
 *  (e.g. softDeleteSubtree visiting the root first). core.merge broke
 *  that implicit obligation — it rehomes children before tombstoning
 *  the merged-from block, so undo restored the children under a
 *  still-tombstoned parent and the whole undo tx aborted with
 *  ParentDeletedError (found by repoMutators.fuzz). Centralizing the
 *  order here removes the per-mutator obligation entirely. */
export const replayApplicationOrder = (
  snapshots: SnapshotsMap,
  direction: 'before' | 'after',
): Array<[string, BlockData | null]> => {
  const live = new Map<string, BlockData>()
  const exempt: Array<[string, BlockData | null]> = []
  for (const [id, snap] of snapshots) {
    const target = snap[direction]
    if (target === null || target.deleted) exempt.push([id, target])
    else live.set(id, target)
  }
  const depth = new Map<string, number>()
  // Iterative memoized walk — a single entry can hold an arbitrarily
  // deep chain (undoing a big subtree delete), and recursing per parent
  // hop would overflow the stack there. Walk up collecting the uncached
  // path, then fill depths back down. A malformed (cyclic) target graph
  // bottoms out at depth 0 for the re-entered node, same as the old
  // recursive pre-seed guard.
  const depthOf = (start: string): number => {
    const path: string[] = []
    const onPath = new Set<string>()
    let id: string | undefined = start
    let base = -1
    while (id !== undefined) {
      const cached = depth.get(id)
      if (cached !== undefined) { base = cached; break }
      if (onPath.has(id)) { base = 0; break }
      path.push(id)
      onPath.add(id)
      const parentId: string | null | undefined = live.get(id)?.parentId
      id = parentId != null && live.has(parentId) ? parentId : undefined
    }
    for (let i = path.length - 1; i >= 0; i--) {
      base += 1
      depth.set(path[i], base)
    }
    return depth.get(start)!
  }
  const ordered = [...live.keys()].sort((a, b) => depthOf(a) - depthOf(b))
  return [
    ...ordered.map(id => [id, live.get(id)!] as [string, BlockData | null]),
    ...exempt,
  ]
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
