/**
 * Core "move these blocks there" operation, shared by the move command
 * and drag-and-drop. One `core.move` per block, all inside ONE
 * transaction: the batch lands whole or not at all, and a single cmd-Z
 * reverts it.
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
import { ChangeScope } from '@/data/api'
import { move, revealChildren, type InsertPosition } from '@/data/mutators.js'
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
  /** The ids that actually moved, in the order they were placed.
   *  Callers need these (not just the count) to subtract them from the
   *  ui-state selection — see `moveAction`. */
  movedIds: readonly string[]
}

/**
 * Prunes descendants out of `blockIds` (via `validateSelectionHierarchy`),
 * then moves what's left to `target`, preserving input order (see the
 * module doc's ordering rule).
 *
 * Pruning here is DEFENCE IN DEPTH: every ui-state selection path
 * already runs `validateSelectionHierarchy` before a selection reaches
 * an action. This re-run covers dispatches with supplied deps that
 * bypass ui-state selection — the agent bridge, group-header buttons,
 * a drag payload.
 *
 * Moving a block into itself or into its own descendant is refused —
 * not by a check here, but because `core.move` → `tx.move` throws
 * `CycleError`. Callers are expected to never offer such a destination;
 * this is only the backstop. Any error (`CycleError`,
 * `ParentDeletedError`, …) rolls the whole batch back and propagates.
 *
 * A collapsed destination is expanded in the same transaction.
 * `core.move` deliberately doesn't reveal — it's the programmatic
 * placement primitive materialization, merge and the agent bridge use,
 * and those must not disturb a user's fold state — but a USER-initiated
 * move into a collapsed block would otherwise make the rows vanish from
 * the source and stay hidden at the target, which reads as data loss.
 */
export const moveBlocksTo = async (
  repo: Repo,
  blockIds: readonly string[],
  target: MoveTarget,
): Promise<MoveBlocksResult> => {
  const prunedIds = await validateSelectionHierarchy([...blockIds], repo)
  if (prunedIds.length === 0) return { moved: 0, movedIds: [] }

  await repo.tx(async tx => {
    // Chain each block after the previous one — see the ordering rule.
    let position = target.position
    for (const id of prunedIds) {
      await tx.run(move, { id, parentId: target.parentId, position })
      position = { kind: 'after', siblingId: id }
    }
    if (target.parentId !== null) await revealChildren(tx, target.parentId)
  }, {
    scope: ChangeScope.BlockDefault,
    description: `move ${prunedIds.length} block${prunedIds.length === 1 ? '' : 's'}`,
  })
  return { moved: prunedIds.length, movedIds: prunedIds }
}
