/**
 * Selection bookkeeping after a move: every selected block the move
 * carried leaves the ui-state selection. Shared by the move command and
 * drag-and-drop.
 */
import type { Block } from '@/data/block'
import type { Repo } from '@/data/repo.js'
import { getSelectionStateSnapshot } from '@/data/stateBlocks.js'
import { selectionStateProp } from '@/data/properties.js'
import { isWithinSubtreeOfAny } from './blockSubtreeMembership.ts'

/** Take every selected id covered by `movedRoots` (see
 *  `selectedIdsCoveredByMove`) out of the selection on `uiStateBlock`. */
export const unselectMovedBlocks = async (
  repo: Repo,
  uiStateBlock: Block,
  movedRoots: readonly string[],
): Promise<void> => {
  await dropMovedFromSelection(
    uiStateBlock,
    await selectedIdsCoveredByMove(repo, uiStateBlock, new Set(movedRoots)),
  )
}

/**
 * Take `idsToRemove` out of the ui-state selection.
 *
 * The selection is ui-state, and `PanelMultiSelectActionContext`
 * activates multi-select from a non-empty `selectedBlockIds` ALONE — it
 * never checks those blocks are still in the panel. Leave a relocated id
 * in there and the pane shows nothing (or only the un-moved remainder)
 * highlighted while `Delete` and the other multi-select shortcuts still
 * act on the block at its new home.
 *
 * Subtracting ids — rather than clearing outright when the dispatch came
 * from multi-select — is what makes the two entry points behave the
 * same. A multi-select move takes out every selected id and so empties
 * the selection anyway, while a context-menu move on one bullet that
 * happens to sit inside a live selection removes just that one and
 * leaves the rest intact. A selection with nothing moved in it is
 * untouched, which is the behaviour a normal-mode move on an unrelated
 * block needs.
 *
 * Callers pass whatever set of ids actually needs to come out — see
 * `selectedIdsCoveredByMove` below for how that set is computed — so this
 * stays a plain, self-contained subtraction.
 */
const dropMovedFromSelection = async (
  uiStateBlock: Block,
  idsToRemove: readonly string[],
): Promise<void> => {
  const current = getSelectionStateSnapshot(uiStateBlock)
  if (!current.selectedBlockIds.length) return

  const toRemove = new Set(idsToRemove)
  const remaining = current.selectedBlockIds.filter(id => !toRemove.has(id))
  if (remaining.length === current.selectedBlockIds.length) return

  await uiStateBlock.set(selectionStateProp, {
    selectedBlockIds: remaining,
    // The anchor is only meaningful while it's still selected; a moved
    // anchor would keep range-extension anchored to an off-surface row.
    anchorBlockId:
      current.anchorBlockId && remaining.includes(current.anchorBlockId)
        ? current.anchorBlockId
        : remaining[0] ?? null,
  })
}

/**
 * Every currently-selected id that ended up covered by one of `movedRoots`
 * (the root itself, or a descendant riding along inside its subtree) — the
 * ids that need to come OUT of the ui-state selection after a move.
 *
 * Subtracting only the ORIGINALLY REQUESTED ids (the old behaviour here)
 * misses a selected descendant that was never itself requested: a
 * single-block or context-menu move passes just the ancestor, so a block
 * that happens to be independently selected inside the moved subtree stays
 * selected at its new, possibly off-panel home, where `Delete` and the
 * other multi-select shortcuts still reach it. Checking every selected id
 * against the roots that actually committed catches that case, while still
 * covering every requested id that moved: whether it committed as a root
 * itself or was pruned as one root's descendant, it is by construction
 * within one of `movedRoots`' subtrees (`isWithinSubtreeOfAny` treats a
 * root as covering itself).
 */
const selectedIdsCoveredByMove = async (
  repo: Repo,
  uiStateBlock: Block,
  movedRoots: ReadonlySet<string>,
): Promise<string[]> => {
  const current = getSelectionStateSnapshot(uiStateBlock)
  if (!current.selectedBlockIds.length) return []

  const covered = await Promise.all(
    current.selectedBlockIds.map(async id =>
      (await isWithinSubtreeOfAny(repo, id, movedRoots)) ? id : null),
  )
  return covered.filter((id): id is string => id !== null)
}
