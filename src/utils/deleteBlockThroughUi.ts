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
 * read the guards as a subtree-wide protection when adding one.
 *
 * The confirmation looks through the entire subtree to count deleted content.
 *
 * Why this is a UI affordance rather than a data-layer guard, and what IS
 * unbypassable instead, is on `BlockDeletionGuard` in `@/extensions/core` —
 * the interface these rules are a contract for.
 *
 * A bare `block.delete()` in handler code is an ESLint error pointing here —
 * discipline that's checked beats discipline that's remembered.
 */
import { ChangeScope, type SubtreeRow } from '@/data/api'
import { deleteBlock, type OccurrenceEdge } from '@/data/mutators'
import type { Block } from '@/data/block.js'
import { repoFieldDefinitionTest } from '@/data/internals/propertySchemaResolution'
import { isPropertyFieldInstance } from '@/data/propertyChildren'
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

/** Ask at this count of affected blocks, as measured by `countBlocksRemovedBy`. */
export const BULK_DELETE_CONFIRM_THRESHOLD = 20

export interface DeleteThroughUiOptions {
  /** Wrap the writes in the move view-transition. Owned here rather than by
   *  the caller because the confirmation must open BEFORE
   *  `document.startViewTransition`: a dialog raised inside the transition
   *  callback renders under the frozen page snapshot, where it cannot be
   *  clicked, and the gesture waits on a promise nobody can resolve. */
  animate?: boolean
  /** Work that must happen while the blocks still exist — a focus target
   *  read out of the subtree about to vanish. Runs after
   *  the guards and the confirmation, so a refused or cancelled gesture never
   *  reaches it, and before the write, which is the only window in which it is
   *  correct. */
  beforeWrite?: () => Promise<void> | void
}

/**
 * Ask the guards, confirm if the delete is big, then delete. Returns whether
 * the delete happened, so callers can skip follow-up work (focus moves,
 * selection resets) when it didn't.
 *
 * Loads the block first: guards inspect types and workspace id, and an unloaded
 * block would answer "no types" and be waved through.
 */
export const deleteBlockThroughUi = async (
  block: Block,
  options?: DeleteThroughUiOptions,
): Promise<boolean> => deleteBlocksThroughUi([block], options)

/** Empty Backspace may wait for confirmation; the captured occurrence must survive until deletion. */
export async function deleteAtOccurrenceThroughUi(
  block: Block,
  expected: OccurrenceEdge & {isCurrent: () => boolean},
  beforeWrite: () => Promise<void>,
): Promise<boolean> {
  if (!await confirmTargets([block], beforeWrite)) return false
  return block.repo.tx(async tx => {
    if (!await expected.currentRow(tx) || !expected.isCurrent()) return false
    await tx.run(deleteBlock, {id: block.id})
    return true
  }, {scope: ChangeScope.BlockDefault, description: 'remove empty block'})
}

/** Batch form: refuses the WHOLE call if any block is protected, rather than
 *  half-deleting the set. One toast, and the user's selection is intact so they
 *  can narrow it and retry — a partial delete is not something they can undo by
 *  re-selecting.
 *
 *  All-or-nothing describes the GUARDS, not the writes. The deletes are N
 *  independent transactions, so a tx-layer refusal on block K (a read-only
 *  workspace, a seeded definition somewhere in its subtree) still leaves
 *  1..K-1 tombstoned. Making that atomic is the same open item as
 *  `applyToAllBlocksInSelection`'s "one tx so undo collapses the batch" todo.
 *
 *  The multi-select `Delete` passes its whole selection here directly. */
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
  if (!await confirmTargets(targets, beforeWrite)) return false
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

async function confirmTargets(targets: readonly Block[], beforeWrite?: DeleteThroughUiOptions['beforeWrite']): Promise<boolean> {
  if (!await ensureDeletableThroughUi(targets)) return false
  if (!await confirmBulkDeleteThroughUi(targets)) return false
  if (beforeWrite) {
    await beforeWrite()
    // Caller work awaits (it walks the tree), so the guards are resolved
    // again rather than writing on a decision taken before it. Gated on there
    // being such work: without it this is the pass above.
    if (!await ensureDeletableThroughUi(targets)) return false
  }
  return true
}

/**
 * The guard check on its own, toast included. Use this when the gesture has
 * work to do BETWEEN deciding and deleting that must not happen for a delete
 * the guards will refuse (a merge's picker, a merge into the previous block).
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
 * without asking, when `countBlocksRemovedBy` is below the threshold.
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

/** Recognized field rows count only when directly targeted. Read the structural
 *  subtree so values and their descendants still count under omitted fields.
 *  Long chains of field rows can push counted blocks beyond the query's depth limit.
 *  Deduplication also skips redundant queries for an ancestor-first selection. */
const countBlocksRemovedBy = async (blocks: readonly Block[]): Promise<number> => {
  const targets = new Set(blocks.map(block => block.id))
  const seen = new Set<string>()
  let count = 0
  for (const block of blocks) {
    if (seen.has(block.id)) continue
    const rows = await block.repo.runQuery<SubtreeRow[]>(
      'core.subtree',
      {id: block.id},
    )
    const [root] = rows
    if (!root) continue
    const isFieldDefinition = repoFieldDefinitionTest(block.repo, root.workspaceId)
    for (const row of rows) {
      if (seen.has(row.id)) continue
      seen.add(row.id)
      if (targets.has(row.id) || !isPropertyFieldInstance(row, isFieldDefinition)) {
        count++
      }
    }
  }
  return count
}
