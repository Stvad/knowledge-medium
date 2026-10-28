/**
 * Core "move these blocks there" operation, shared by the move command
 * and drag-and-drop: every block moves inside ONE transaction, so the
 * batch lands whole or not at all, and a single cmd-Z reverts it. The
 * batch ordering rule lives with the in-tx primitive, `moveBlocksInTx`
 * (`@/data/mutators.js`), which a paste completing a cut also uses.
 */
import type { Repo } from '@/data/repo.js'
import { ChangeScope } from '@/data/api'
import { moveBlocksInTx, revealChildren, type MoveTarget } from '@/data/mutators.js'
import { validateSelectionHierarchy } from '@/utils/selection.js'
import { pluralize } from '@/utils/pluralize.js'

export type { MoveTarget }

export interface MoveBlocksResult {
  /** The roots that moved (descendants pruned), in the order they were
   *  placed. Never empty for a non-empty input. */
  movedIds: readonly string[]
}

/**
 * Prunes descendants out of `blockIds` (via `validateSelectionHierarchy`),
 * then moves what's left to `target`, preserving input order.
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
  if (prunedIds.length === 0) return { movedIds: [] }

  await repo.tx(async tx => {
    await moveBlocksInTx(tx, prunedIds, target)
    if (target.parentId !== null) await revealChildren(tx, target.parentId)
  }, {
    scope: ChangeScope.BlockDefault,
    description: `move ${pluralize(prunedIds.length, 'block')}`,
  })
  return { movedIds: prunedIds }
}
