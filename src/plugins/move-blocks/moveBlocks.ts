/**
 * Core "move these blocks there" operation, shared by the move command,
 * paste-as-move, and (eventually) drag-and-drop. One `core.move`
 * (`src/data/mutators.ts:467`) per block inside one `repo.undoGroup`, so
 * a single cmd-Z reverts the whole batch.
 *
 * `core.move` already owns order-key math, the cycle guard, and
 * workspace pinning — this helper never touches order keys or `tx.move`
 * directly.
 *
 * ## The ordering rule
 *
 * Only the FIRST block goes to the caller's requested position; every
 * subsequent block is placed `{kind: 'after'}` its predecessor. Reusing
 * the caller's position for all N is the obvious loop and it is WRONG
 * for two of the four position kinds — it silently reverses the batch:
 *
 * | position          | naive loop (A,B,C) | chained (A,B,C) |
 * |-------------------|--------------------|-----------------|
 * | `last`            | A,B,C ✓            | A,B,C ✓         |
 * | `before X`        | A,B,C,X ✓          | A,B,C,X ✓       |
 * | `first`           | **C,B,A** ✗        | A,B,C ✓         |
 * | `after X`         | X,**C,B,A** ✗      | X,A,B,C ✓       |
 *
 * `last` and `before X` happen to survive because each insert lands past
 * (or immediately ahead of) a fixed point; `first` and `after X` both
 * re-target the same slot every iteration and stack up backwards.
 * Chaining is uniform, so the caller never has to know which kind is
 * order-safe.
 */
import type { Repo } from '@/data/repo.js'
import type { InsertPosition } from '@/data/mutators.js'
import { validateSelectionHierarchy } from '@/utils/selection.js'

/** Where a batch should land: a parent (`null` = workspace root) plus
 *  the placement of the FIRST block within that parent's child list.
 *  Subsequent blocks chain after it — see {@link moveBlocksTo}. */
export interface MoveTarget {
  parentId: string | null
  position: InsertPosition
}

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
 * then moves what's left to `target`, preserving input order (see the
 * module doc's ordering rule).
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
  target: MoveTarget,
): Promise<MoveBlocksResult> => {
  const prunedIds = await validateSelectionHierarchy([...blockIds], repo)
  if (prunedIds.length === 0) return { moved: 0 }

  let moved = 0
  try {
    await repo.undoGroup(async grouped => {
      // Chain each block after the previous one — see the ordering rule.
      let position = target.position
      for (const id of prunedIds) {
        await grouped.mutate.move({
          id,
          parentId: target.parentId,
          position,
        })
        moved += 1
        position = { kind: 'after', siblingId: id }
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
