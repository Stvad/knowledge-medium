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
import { move as moveMutator, type InsertPosition } from '@/data/mutators.js'
import { ChangeScope } from '@/data/api'
import { validateSelectionHierarchy } from '@/utils/selection.js'
import { isCollapsedProp } from '@/data/properties.js'

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
  /** The ids that DID land, so the caller can still do the bookkeeping a
   *  success would have done — notably taking them out of the ui-state
   *  selection, which otherwise keeps pointing shortcuts at blocks that
   *  have already relocated. */
  readonly movedIds: readonly string[]

  constructor(movedIds: readonly string[], override readonly cause: unknown) {
    const detail = cause instanceof Error ? cause.message : String(cause)
    const moved = movedIds.length
    super(
      `Moved ${moved} block${moved === 1 ? '' : 's'} before failing: ${detail}. `
      + 'Undo (cmd-Z) reverts the blocks that did move.',
    )
    this.name = 'PartialMoveError'
    this.movedIds = movedIds
  }

  get moved(): number { return this.movedIds.length }
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
  if (prunedIds.length === 0) return { moved: 0, movedIds: [] }

  let moved = 0
  const movedIds: string[] = []
  try {
    await repo.undoGroup(async grouped => {
      // Chain each block after the previous one — see the ordering rule.
      let position = target.position
      for (const id of prunedIds) {
        // Liveness is checked in the SAME transaction that relocates the
        // block, against its own row. `core.move` deliberately permits
        // moving a tombstone (materialization and undo replay need that),
        // so a caller that pre-filtered with a separate query counts a
        // block deleted in the meantime as moved — and reports success for
        // a batch that visibly did nothing.
        const relocated = await grouped.tx(async tx => {
          const row = await tx.get(id)
          if (!row || row.deleted) return false
          await tx.run(moveMutator, {id, parentId: target.parentId, position})
          return true
        }, {scope: ChangeScope.BlockDefault, description: `move ${id}`})
        if (!relocated) continue
        moved += 1
        movedIds.push(id)
        // Reveal after the FIRST block lands, not after the loop. Each
        // move commits its own tx, so a failure partway through would
        // skip an end-of-loop reveal and leave the blocks that DID move
        // hidden under a collapsed destination — while the error says
        // "Moved N blocks". Placed after the move rather than before the
        // loop so a batch that lands nothing doesn't expand anything (or
        // mint an undo entry holding only the reveal).
        if (moved === 1) await revealDestination(grouped, target.parentId)
        position = { kind: 'after', siblingId: id }
      }
    })
  } catch (error) {
    // Nothing committed yet → the original error is the whole story.
    // Otherwise the caller needs the ids (see `PartialMoveError`).
    if (moved === 0) throw error
    throw new PartialMoveError([...movedIds], error)
  }
  return { moved, movedIds }
}

/**
 * Expand the destination if it was collapsed.
 *
 * `core.move` deliberately doesn't do this — it's the explicit,
 * programmatic placement primitive that materialization, merge and the
 * agent bridge use, and those must not disturb a user's fold state. But
 * a USER-initiated move into a collapsed block would otherwise show a
 * "Moved N blocks" toast while the rows vanish from the source and stay
 * hidden at the target, which reads as data loss. `core.indent` and
 * `core.moveVertical` reveal for exactly this reason
 * (`src/data/mutators.ts:551`); this is the same courtesy at the UI
 * layer, where it belongs.
 *
 * Goes through `grouped.mutate` rather than `grouped.block(id).set(…)`:
 * the undo-group facade deliberately mints Blocks through the REAL repo
 * (`src/data/repo.ts:1625-1633`), so a `block.set` here would commit
 * outside the group and split the batch into two undo entries.
 */
const revealDestination = async (
  grouped: Repo,
  parentId: string | null,
): Promise<void> => {
  if (parentId === null) return
  const destination = grouped.block(parentId)
  // Load rather than peek: `core.move` reads the destination's children
  // inside the tx, which does NOT populate this Block facade's cache, so
  // a peek here can report `undefined` for a genuinely collapsed row and
  // silently skip the reveal.
  await destination.load()
  if (destination.peekProperty(isCollapsedProp) !== true) return
  await grouped.mutate.setProperty({
    id: parentId,
    schema: isCollapsedProp,
    value: false,
  })
}
