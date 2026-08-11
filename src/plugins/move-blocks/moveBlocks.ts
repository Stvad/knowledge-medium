/**
 * Core "move block(s) to…" operation. Moves `blockIds` to be the last
 * children of `destinationId`, one `core.move` (`src/data/mutators.ts:467`)
 * per block, SEQUENTIALLY in the given order — each lands after the
 * previous, so the whole set ends up contiguous under the destination
 * in its original relative order. The sequence runs inside one
 * `repo.undoGroup` so a single cmd-Z reverts the entire batch.
 *
 * `core.move` already owns order-key math, the cycle guard, and
 * workspace pinning — this helper never touches order keys or `tx.move`
 * directly.
 */
import type { Repo } from '@/data/repo.js'
import { validateSelectionHierarchy } from '@/utils/selection.js'

export interface MoveBlocksResult {
  /** Count of blocks actually moved, after descendant pruning. */
  moved: number
}

/**
 * Thrown when the batch failed PART-WAY: `moved` blocks are already at
 * the destination, the rest are untouched.
 *
 * `undoGroup` folds the batch into one undo *entry*, but each
 * `core.move` still commits its own tx (`repo.ts:1613-1619`) — so an
 * error on block k+1 leaves blocks 1..k moved. The user has to be told
 * that, or they read "failed" and don't go looking for the blocks that
 * did move. The committed prefix shares the group token, so one cmd-Z
 * still reverts all of it — hence the recovery hint in the message.
 */
export class PartialMoveError extends Error {
  constructor(readonly moved: number, override readonly cause: unknown) {
    const detail = cause instanceof Error ? cause.message : String(cause)
    super(
      `Moved ${moved} block${moved === 1 ? '' : 's'} before failing: ${detail}. `
      + 'Undo (cmd-Z) reverts the blocks that did move.',
    )
    this.name = 'PartialMoveError'
  }
}

/**
 * Prunes descendants out of `blockIds` (via `validateSelectionHierarchy`),
 * then moves what's left to the end of `destinationId`'s children, in
 * order.
 *
 * Pruning here is DEFENCE IN DEPTH: every ui-state selection path
 * already runs `validateSelectionHierarchy` before a selection reaches
 * an action (`src/utils/selection.ts:334,366,398,410`,
 * `src/extensions/blockSelectionAction.ts:75`). This re-run covers
 * dispatches with supplied deps that bypass ui-state selection — the
 * agent bridge, group-header buttons.
 *
 * Moving a block into itself or into its own descendant is refused —
 * not by a check here, but because `core.move` → `tx.move` throws
 * `CycleError` for exactly that (`src/data/internals/txEngine.ts:640`).
 * The picker is expected to never offer such a destination; this is
 * only the backstop. `CycleError` / `ParentDeletedError` propagate out
 * of this helper uncaught when NOTHING committed; once part of the
 * batch has landed they are wrapped in {@link PartialMoveError} so the
 * caller can say how much moved. Either way the action layer toasts.
 */
export const moveBlocksTo = async (
  repo: Repo,
  blockIds: readonly string[],
  destinationId: string,
): Promise<MoveBlocksResult> => {
  const prunedIds = await validateSelectionHierarchy([...blockIds], repo)
  if (prunedIds.length === 0) return { moved: 0 }

  let moved = 0
  try {
    await repo.undoGroup(async grouped => {
      for (const id of prunedIds) {
        await grouped.mutate.move({
          id,
          parentId: destinationId,
          position: { kind: 'last' },
        })
        moved += 1
      }
    })
  } catch (error) {
    // Nothing committed yet → the original error is the whole story.
    // Otherwise the caller needs the count (see `PartialMoveError`).
    if (moved === 0) throw error
    throw new PartialMoveError(moved, error)
  }
  return { moved }
}
