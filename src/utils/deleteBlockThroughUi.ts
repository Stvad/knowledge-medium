/**
 * The single choke point for deleting a block **from the UI**.
 *
 * Every user-initiated delete goes through here so the deletion guards
 * (`blockDeletionGuardsFacet`) are consulted exactly once, in one place. The
 * previous shape — each handler calling `block.delete()` and remembering to ask
 * first — lasted one commit before diverging: `delete_block` checked,
 * `delete_empty_block_cm` and `cut_selected_blocks` did not, so `Delete` on a
 * daily note was refused while `d` on the same selection destroyed it.
 *
 * Deliberately NOT a data-layer guard. `block.delete()` stays unguarded for
 * programmatic callers (the agent bridge, migrations, cleanup); the rules that
 * genuinely cannot be bypassed live in the tx engine
 * (`SeededDefinitionWriteError`, read-only workspaces).
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

/** Batch form: refuses the WHOLE gesture if any block is protected, rather than
 *  half-deleting a selection. One toast, and the user's selection is intact so
 *  they can narrow it and retry — a partial cut is not something they can undo
 *  by re-selecting. */
export const deleteBlocksThroughUi = async (blocks: readonly Block[]): Promise<boolean> => {
  if (!await ensureDeletableThroughUi(blocks)) return false
  // eslint-disable-next-line no-restricted-syntax -- this IS the guarded choke point
  for (const block of blocks) await block.delete()
  return true
}

/**
 * The guard check on its own, toast included. Use this when the gesture has
 * work to do BETWEEN deciding and deleting — `cut_selected_blocks` has to write
 * the clipboard while the blocks still exist, and must not write it at all for
 * a cut the guards will refuse.
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
