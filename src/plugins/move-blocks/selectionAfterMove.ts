/**
 * Selection bookkeeping after a move. Shared by the move command and
 * drag-and-drop.
 */
import type { Block } from '@/data/block'
import type { Repo } from '@/data/repo.js'
import { getSelectionStateSnapshot } from '@/data/stateBlocks.js'
import { selectionStateProp } from '@/data/properties.js'
import { isWithinSubtreeOfAny } from './blockSubtreeMembership.ts'

/**
 * Take every selected block that `movedRoots` carried — a root itself, or
 * a descendant riding inside one — out of the ui-state selection on
 * `uiStateBlock`.
 *
 * `PanelMultiSelectActionContext` activates multi-select from a non-empty
 * `selectedBlockIds` alone, never checking those blocks are still in the
 * panel, so a relocated id left in there keeps `Delete` and the other
 * multi-select shortcuts acting on it at its new home.
 *
 * Covered, not requested: a single-block move passes just the ancestor,
 * and a block independently selected inside its subtree moved too.
 * Subtracting rather than clearing keeps a selection the move didn't
 * touch — a context-menu move on one bullet inside a live selection
 * removes just that one.
 */
export const unselectMovedBlocks = async (
  repo: Repo,
  uiStateBlock: Block,
  movedRoots: readonly string[],
): Promise<void> => {
  const roots = new Set(movedRoots)
  const covered = new Set<string>()
  await Promise.all(getSelectionStateSnapshot(uiStateBlock).selectedBlockIds.map(async id => {
    if (await isWithinSubtreeOfAny(repo, id, roots)) covered.add(id)
  }))
  if (covered.size === 0) return

  // Re-read after the awaits: subtract from the selection as it is now.
  const current = getSelectionStateSnapshot(uiStateBlock)
  const remaining = current.selectedBlockIds.filter(id => !covered.has(id))
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
