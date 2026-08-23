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
 *  Sized for a confirmation that stays worth reading: one the user meets often
 *  enough to click through without looking is worse than none, since it trains
 *  the reflex it exists to interrupt. The count includes property field/value
 *  rows, so a property-heavy block reads higher than what is on screen — if
 *  this starts asking about deletes that look small, that inflation is the
 *  first thing to check, not the number here (issue #738). */
export const BULK_DELETE_CONFIRM_THRESHOLD = 20

export interface DeleteThroughUiOptions {
  /** Wrap the writes in the move view-transition. Owned here rather than by
   *  the caller because the confirmation must open BEFORE
   *  `document.startViewTransition`: a dialog raised inside the transition
   *  callback renders under the frozen page snapshot, where it cannot be
   *  clicked, and the gesture waits on a promise nobody can resolve. */
  animate?: boolean
  /** Set by a gesture that has already run {@link confirmBulkDeleteThroughUi}
   *  over these same blocks because it has work to do between asking and
   *  writing (the cut path's clipboard write). It suppresses the second ask,
   *  and nothing else — the guards are still re-checked immediately before the
   *  write. */
  alreadyConfirmed?: boolean
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
 *  Both multi-block gestures get this. `cut_selected_blocks` passes its whole
 *  selection here directly; `multi_select.delete_block` fans out per block
 *  through `applyToAllBlocksInSelection`, so it runs the same check once over
 *  the selection as that helper's `preflight` before any block is touched.
 *  `Delete` and `d` on the same selection must not disagree. */
export const deleteBlocksThroughUi = async (
  blocks: readonly Block[],
  {animate = false, alreadyConfirmed = false}: DeleteThroughUiOptions = {},
): Promise<boolean> => {
  if (!await ensureDeletableThroughUi(blocks)) return false
  if (!alreadyConfirmed && !await confirmBulkDeleteThroughUi(blocks)) return false
  const write = async (): Promise<void> => {
    // eslint-disable-next-line no-restricted-syntax -- this IS the guarded choke point
    for (const block of blocks) await block.delete()
  }
  await (animate ? withMoveTransition(write) : write())
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

/**
 * User consent for a delete big enough to be worth a second look. Answers true
 * — without asking anything — for the small deletes that make up nearly every
 * gesture.
 *
 * Measured over everything the delete removes, not over the blocks the gesture
 * names: `block.delete()` takes the whole subtree, so one Delete on a collapsed
 * page destroys as much as a large selection does, and it's the case the user
 * can least see coming. That's also why this is not folded into
 * `ensureDeletableThroughUi` — merge runs those guards to veto destroying its
 * source block, but a merge REPARENTS the children rather than deleting them,
 * so counting the subtree there would warn about blocks that survive.
 *
 * Counts what the delete REMOVES — the full subtree, the same walk
 * `deleteSubtreeInTx` makes. The visible view is the tempting one (its number
 * is the one the user can count on screen) and it is wrong here: it prunes at
 * a recognized field row, taking that row's whole branch with it, and an
 * authored comment thread under a property value lives in that branch. Those
 * blocks are deleted either way, so counting them out is the one direction of
 * error that matters — it does not merely understate the number, it can drop
 * the total under the threshold and skip the question entirely.
 *
 * The cost is that machinery rows count too, so a property-heavy block reads
 * higher than what is on screen. In a workspace that has not flipped to
 * properties-as-blocks there are no such rows and the two views agree. If the
 * inflation ever makes this ask too often, the fix is a counting view in the
 * data layer that drops machinery WITHOUT pruning its authored descendants —
 * not a hand-rolled field-row classifier here, which is the restatement §9's
 * named-predicate discipline exists to prevent.
 *
 * Separate export because a gesture that works between deciding and writing has
 * to ask before that work, not after — see `alreadyConfirmed`.
 *
 * Re-resolves the guards after the dialog closes, so `false` here can mean
 * either "the user declined" or "a guard started refusing while we asked" —
 * both are "don't proceed", which is all any caller does with it. The gap is
 * human-scale (a sync can land a daily-note type mid-dialog) and this function
 * is the one that opens it, so it is the one that closes it. Doing it here
 * rather than in the choke point also keeps the no-dialog path — nearly every
 * delete — at exactly one guard pass.
 */
export const confirmBulkDeleteThroughUi = async (blocks: readonly Block[]): Promise<boolean> => {
  if (blocks.length === 0) return true
  const totalCount = await countBlocksRemovedBy(blocks)
  if (totalCount < BULK_DELETE_CONFIRM_THRESHOLD) return true
  const confirmed = await openDialog(ConfirmBulkDeleteDialog, {
    targetCount: blocks.length,
    totalCount,
  })
  if (confirmed !== true) return false
  return ensureDeletableThroughUi(blocks)
}

/** Live blocks the delete would tombstone. Deduped across the input: a
 *  selection may hold both a block and its descendant — an outline range
 *  spanning an expanded parent and its children is the ordinary way to get
 *  one — and the delete visits each row once.
 *
 *  Skipping a target already covered by an earlier target's subtree is a
 *  saving, not a correctness condition: the count is the same either way, but
 *  selecting a page and its 200 children costs 1 query instead of 201. It pays
 *  off when targets arrive ancestor-first, which is outline order, so callers
 *  pass selection order here and leave the leaf-first ordering to the delete
 *  itself. A leaf-first list just pays the redundant queries. */
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
