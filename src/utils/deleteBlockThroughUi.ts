/**
 * The single choke point for deleting a block **from the UI**.
 *
 * Every user-initiated delete goes through here so the deletion guards
 * (`blockDeletionGuardsFacet`) are consulted in one place.
 *
 * Scope: the guards are asked about the blocks the GESTURE targets, not about
 * every block the delete will tombstone. `block.delete()` cascades through
 * `deleteSubtreeInTx`, so a guarded block sitting under a deleted ancestor goes
 * with it, unasked. That's deliberate — this is a UI affordance stopping a
 * keystroke from doing something pointless, not an immortality bit — but don't
 * read the guards as a subtree-wide protection when adding one. The
 * previous shape — each handler calling `block.delete()` and remembering to ask
 * first — lasted one commit before diverging: `delete_block` checked,
 * `delete_empty_block_cm` and `cut_selected_blocks` did not, so `Delete` on a
 * daily note was refused while `d` on the same selection destroyed it.
 *
 * Why this is a UI affordance rather than a data-layer guard, and what IS
 * unbypassable instead, is on `BlockDeletionGuard` in `@/extensions/core` —
 * the interface these rules are a contract for.
 *
 * A bare `block.delete()` in handler code is an ESLint error pointing here —
 * discipline that's checked beats discipline that's remembered.
 */
import type { Block } from '@/data/block.js'
import { resolveDeletionRefusal } from '@/extensions/core.js'
import { showInfo } from '@/utils/toast.js'

/** Stable toast id so a multi-block gesture that trips the same guard N times
 *  surfaces ONE message instead of a stack of identical ones (sonner dedupes
 *  by id). */
const REFUSAL_TOAST_ID = 'block-deletion-refused'

/**
 * Ask the guards, then delete. Returns whether the delete happened, so callers
 * can skip follow-up work (focus moves, clipboard writes, selection resets)
 * when it didn't.
 *
 * Loads the block first: guards inspect types and workspace id, and an unloaded
 * block would answer "no types" and be waved through.
 */
export const deleteBlockThroughUi = async (block: Block): Promise<boolean> =>
  deleteBlocksThroughUi([block])

/** Batch form: refuses the WHOLE call if any block is protected, rather than
 *  half-deleting the set. One toast, and the user's selection is intact so they
 *  can narrow it and retry — a partial cut is not something they can undo by
 *  re-selecting.
 *
 *  All-or-nothing describes the GUARDS, not the writes. The deletes are N
 *  independent transactions, so a tx-layer refusal on block K (a read-only
 *  workspace, a seeded definition somewhere in its subtree) still leaves
 *  1..K-1 tombstoned. Making that atomic is the same open item as
 *  `applyToAllBlocksInSelection`'s "one tx so undo collapses the batch" todo.
 *
 *  `multi_select.delete_block` (bound to `Delete`) passes its whole selection
 *  here directly. `cut_selected_blocks` (bound to `$mod+x` / `d`) no longer
 *  does — since issue "true block move instead of serialize-delete-reparse"
 *  cut is non-destructive: it puts the blocks' identity on the clipboard and
 *  a later paste relocates them, so it never reaches this module at all. See
 *  `@/utils/copy.js`'s `cutBlockIdsToClipboard`. */
export const deleteBlocksThroughUi = async (blocks: readonly Block[]): Promise<boolean> => {
  if (!await ensureDeletableThroughUi(blocks)) return false
  // eslint-disable-next-line no-restricted-syntax -- this IS the guarded choke point
  for (const block of blocks) await block.delete()
  return true
}

/**
 * The guard check on its own, toast included. Use this when a gesture has
 * work to do BETWEEN deciding and deleting — `deleteSelectedBlocks` computes
 * a post-delete focus target from the tree before it's torn down, so it
 * needs the decision first and the delete second rather than one call
 * to `deleteBlocksThroughUi`.
 */
export const ensureDeletableThroughUi = async (blocks: readonly Block[]): Promise<boolean> => {
  await Promise.all(blocks.map(block => block.load()))
  for (const block of blocks) {
    const refusal = await resolveDeletionRefusal(block.repo, block)
    if (refusal) {
      showInfo(refusal, {id: REFUSAL_TOAST_ID})
      return false
    }
  }
  return true
}
