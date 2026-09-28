/**
 * The single choke point for deleting a block **from the UI**.
 *
 * Every user-initiated delete goes through here so the deletion guards
 * (`blockDeletionGuardsFacet`) are consulted, and a large enough delete is
 * confirmed, in one place.
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
 * The CONFIRMATION is scoped the other way round, to everything that will be
 * tombstoned — see {@link confirmBulkDeleteThroughUi}.
 *
 * Why this is a UI affordance rather than a data-layer guard, and what IS
 * unbypassable instead, is on `BlockDeletionGuard` in `@/extensions/core` —
 * the interface these rules are a contract for.
 *
 * A bare `block.delete()` in handler code is an ESLint error pointing here —
 * discipline that's checked beats discipline that's remembered.
 */
import type { SubtreeRow } from '@/data/api'
import type { Block } from '@/data/block.js'
import { ConfirmBulkDeleteDialog } from '@/components/ConfirmBulkDeleteDialog.js'
import { withEditModeKeepalive } from '@/components/editModeKeepalive.js'
import { resolveDeletionRefusal } from '@/extensions/core.js'
import { openDialog } from '@/utils/dialogs.js'
import { showInfo } from '@/utils/toast.js'
import { withMoveTransition } from '@/utils/viewTransition.js'

/** Stable toast id so a multi-block gesture that trips the same guard N times
 *  surfaces ONE message instead of a stack of identical ones (sonner dedupes
 *  by id). */
const REFUSAL_TOAST_ID = 'block-deletion-refused'

/** How many blocks one gesture may remove before it has to ask. Counted over
 *  the whole affected set, so the number means the same thing whether the user
 *  selected 30 blocks or pressed Delete on one collapsed page holding 30.
 *
 *  Sized for a confirmation that stays worth reading: one met often enough to
 *  click through without looking is worse than none. If it starts asking about
 *  deletes that look small, read `countBlocksRemovedBy` before changing this
 *  number — what it counts is the likelier cause. */
export const BULK_DELETE_CONFIRM_THRESHOLD = 20

export interface DeleteThroughUiOptions {
  /** Wrap the writes in the move view-transition. Owned here rather than by
   *  the caller because the confirmation must open BEFORE
   *  `document.startViewTransition`: a dialog raised inside the transition
   *  callback renders under the frozen page snapshot, where it cannot be
   *  clicked, and the gesture waits on a promise nobody can resolve. */
  animate?: boolean
  /** Work that must happen while the blocks still exist — a cut's clipboard
   *  write, a focus target read out of the subtree about to vanish. Runs after
   *  the guards and the confirmation, so a refused or cancelled gesture never
   *  reaches it, and before the write, which is the only window in which it is
   *  correct. Callers used to sequence this themselves and each had to
   *  remember the same order. */
  beforeWrite?: () => Promise<void> | void
}

/**
 * Ask the guards, confirm if the delete is big, then delete. Returns whether
 * the delete happened, so callers can skip follow-up work (focus moves,
 * clipboard writes, selection resets) when it didn't.
 *
 * Loads the block first: guards inspect types and workspace id, and an unloaded
 * block would answer "no types" and be waved through.
 */
export const deleteBlockThroughUi = async (
  block: Block,
  options?: DeleteThroughUiOptions,
): Promise<boolean> =>
  deleteBlocksThroughUi([block], options)

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
 *  `multi_select.delete_block` fans out per block through
 *  `applyToAllBlocksInSelection`, so it runs the same check once over the
 *  selection as that helper's `preflight` before any block is touched.
 *
 *  `cut_selected_blocks` no longer arrives here: cut puts the blocks'
 *  identity on the clipboard and a later paste relocates them, so it deletes
 *  nothing (`@/utils/copy.js`'s `cutBlockIdsToClipboard`). `beforeWrite`
 *  remains for the other gestures that need interstitial work between the
 *  guards and the write. */
export const deleteBlocksThroughUi = async (
  blocks: readonly Block[],
  {animate = false, beforeWrite}: DeleteThroughUiOptions = {},
): Promise<boolean> => {
  // One entry per block for the whole gesture. A caller can hand over the same
  // id twice — `run-action multi_select.delete_block` maps raw
  // `selectedBlockIds` straight through — and the count already dedupes, so
  // without this the dialog says "25 selected blocks" over a 20-block total
  // and the write repeats itself.
  const targets = [...new Map(blocks.map(block => [block.id, block])).values()]
  if (!await ensureDeletableThroughUi(targets)) return false
  if (!await confirmBulkDeleteThroughUi(targets)) return false
  if (beforeWrite) {
    await beforeWrite()
    // Caller work of unbounded duration — the cut path serializes every
    // selected subtree and awaits the clipboard API — so the guards are
    // resolved again rather than writing on a decision taken before it. Gated
    // on there being such work: without it this is the pass above.
    if (!await ensureDeletableThroughUi(targets)) return false
  }
  const write = async (): Promise<void> => {
    // Leaf-first so each removal can't disturb the next. Owned here, with the
    // ancestor-first order `countBlocksRemovedBy` wants, so callers pass one
    // list in outline order and neither ordering can be got wrong at a site.
    // eslint-disable-next-line no-restricted-syntax -- this IS the guarded choke point
    for (const block of targets.toReversed()) await block.delete()
  }
  await (animate ? withMoveTransition(write) : write())
  return true
}

/**
 * The guard check on its own, toast included. Use this when the gesture has
 * work to do BETWEEN deciding and deleting — `deleteSelectedBlocks` computes
 * its post-delete focus target from the tree before it is torn down, and must
 * not do that work at all for a delete the guards will refuse.
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

/**
 * User consent for a delete big enough to be worth a second look — true,
 * without asking, for the small deletes that are nearly every gesture. Measured
 * over what the delete REMOVES (`countBlocksRemovedBy`), not over the blocks
 * the gesture names.
 *
 * Deliberately not folded into `ensureDeletableThroughUi`: merge runs those
 * guards to veto destroying its source block, but REPARENTS the children, so
 * counting the subtree there would warn about blocks that survive.
 *
 * Re-resolves the guards after the dialog closes, so `false` means either "the
 * user declined" or "a guard started refusing while we asked" — both being
 * "don't proceed", which is all any caller does with it. The wait is
 * human-scale (a sync can land a daily-note type mid-dialog); closing that gap
 * here rather than in the choke point keeps the no-dialog path at one guard
 * pass.
 */
const confirmBulkDeleteThroughUi = async (blocks: readonly Block[]): Promise<boolean> => {
  if (blocks.length === 0) return true
  const totalCount = await countBlocksRemovedBy(blocks)
  if (totalCount < BULK_DELETE_CONFIRM_THRESHOLD) return true
  // Radix takes DOM focus, which the editor's blur handler reads as "editing
  // ended" — dropping the block being asked about out of edit mode under the
  // open modal. 'yield-focus', not 'refocus': the dialog must keep the focus it
  // took. Held here, not at the one caller that reaches this from a live
  // editor, so a later caller cannot forget it.
  const confirmed = await withEditModeKeepalive('yield-focus', () =>
    openDialog(ConfirmBulkDeleteDialog, {
      targetCount: blocks.length,
      totalCount,
    }))
  if (confirmed !== true) return false
  return ensureDeletableThroughUi(blocks)
}

/** Live blocks the delete would tombstone — the single owner of what "how many
 *  blocks" means here; `BULK_DELETE_CONFIRM_THRESHOLD` and
 *  `confirmBulkDeleteThroughUi` both defer to it.
 *
 *  The FULL subtree, matching `deleteSubtreeInTx`'s walk, NOT the visible view.
 *  The visible view prunes at a recognized field row and takes that row's whole
 *  branch, including any authored comment thread under a property value — which
 *  the delete removes regardless. Undercounting is the one direction of error
 *  that matters: it can drop the total under the threshold and skip the
 *  question entirely. The price is that machinery rows count too, so a
 *  property-heavy block reads higher than what is on screen; if that starts
 *  asking about deletes that look small, the fix is a data-layer count that
 *  drops machinery without pruning its authored descendants, never a field-row
 *  classifier restated here (issue #738).
 *
 *  Deduping is a saving, not a correctness condition — the count is the same
 *  either way, but a page selected with its 200 children costs 1 query instead
 *  of 201. It only pays when targets arrive ancestor-first, so callers pass
 *  selection order and leave the leaf-first ordering to the delete. */
const countBlocksRemovedBy = async (blocks: readonly Block[]): Promise<number> => {
  const ids = new Set<string>()
  for (const block of blocks) {
    if (ids.has(block.id)) continue
    const rows = await block.repo.runQuery<SubtreeRow[]>(
      'core.subtree',
      {id: block.id},
    )
    for (const row of rows) ids.add(row.id)
  }
  return ids.size
}
