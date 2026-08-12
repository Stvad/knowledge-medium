/**
 * The move-blocks plugin's contribution to `pasteAsMoveVerb`
 * (`@/paste/moveOnPasteVerb.js`) — the actual "does this paste complete a
 * pending cut?" decision, plus the write. Core owns the seam and the
 * register; this is the one place that's allowed to call `moveBlocksTo`
 * (core can't — see the verb's module doc).
 *
 * The register is CLAIMED synchronously at entry (`getPendingMove` +
 * `clearPendingMove`, no `await` between them) before any of the checks
 * below run — see the first block of `pasteAsMoveImpl`. Two pastes fired in
 * quick succession (or from two panels) can't both read the same pending
 * move and both call `moveBlocksTo`: whichever caller's synchronous
 * prologue runs first wins the claim (JS has no interleaving before the
 * first `await`), and the other sees `getPendingMove()` return `null`, same
 * as "nothing pending" — falls back to an ordinary paste rather than racing
 * a second move against the first's chained `after` anchors.
 *
 * The `clipboardText` sentinel is checked FIRST, ahead of every branch
 * that would preserve the register — it's the validity question ("is this
 * cut still a thing at all"), where the rest are applicability questions
 * ("does it apply to THIS paste"). An invalidated register must never be
 * restored by a later branch.
 *
 * Every branch below that decides the register should SURVIVE (rather than
 * stay dropped, as the claim above already left it) hands it back through
 * `restoreClaim`, which yields to a newer cut rather than burying it. The
 * branches, and why each keeps the claim:
 *   - `pending.workspaceId` doesn't match the paste's `repo.activeWorkspaceId`
 *     — the cut is still perfectly valid back in its own workspace, only
 *     THIS paste doesn't apply. Toasts to say a copy landed instead (this
 *     paste still falls through to an ordinary text paste).
 *   - the destination is inside (or is) one of the blocks being moved — a
 *     cycle. Falling through to a text paste there would silently DUPLICATE
 *     the cut content (parse the cut markdown into brand-new blocks right
 *     there) while the original, un-deleted blocks are still sitting
 *     wherever they were — worse than doing nothing. So this case refuses
 *     with a toast and reports "handled" (no text paste), same as a
 *     successful move, but restores the register so the user can aim
 *     somewhere valid — dropping it would just defer that same duplication
 *     to their next paste.
 *   - `moveBlocksTo` throws a `PartialMoveError` (k of the N live ids
 *     landed before block k+1 failed) — restores the register narrowed to
 *     the ids that did NOT move, so the next paste finishes the rest
 *     instead of re-duplicating the k that already landed.
 *   - anything else throws with nothing committed — `moveBlocksTo` failing
 *     before its first tx, or one of the PRE-move reads (`liveBlockIds`,
 *     the cycle probe) rejecting on a transient database failure. The whole
 *     set is exactly where it was; restores the register UNCHANGED. Those
 *     reads sit INSIDE the same try for this reason: they run after the
 *     claim, so letting them reject past it would drop the register with
 *     the blocks still in place, and the next paste would take the text
 *     path and duplicate them.
 *
 * The other two invalidating cases genuinely drop the register (already
 * dropped by the entry claim, nothing to restore):
 *   - `clipboardText` no longer matches `pending.clipboardText` — the
 *     invalidation sentinel; see `PendingMove`'s doc and
 *     `cutBlockIdsToClipboard` for how it's established. A copy, in-app or
 *     from another app, happened since the cut, so this paste can't be a
 *     move — falls through to an ordinary (correct) text paste of whatever
 *     IS on the clipboard now.
 *   - NONE of `pending.blockIds` are still live (all tombstoned) — nothing
 *     left to move. When only SOME are dead, the survivors still move (see
 *     `liveBlockIds`) and a toast notes the ones that were skipped, so the
 *     paste doesn't silently move fewer blocks than the user cut.
 */
import type { Repo } from '@/data/repo.js'
import { liveBlockIds } from '@/data/blockLiveness.js'
import { showError, showInfo, showSuccess } from '@/utils/toast.js'
import { clearPendingMove, getPendingMove, setPendingMove, type PendingMove } from '@/utils/pendingMove.js'
import type { PasteAsMoveInput, PasteMoveTarget } from '@/paste/moveOnPasteVerb.js'
import { clipboardClaim } from '@/utils/copy.js'
import { moveBlocksTo, PartialMoveError } from './moveBlocks.ts'
import { isWithinSubtreeOfAny } from './blockSubtreeMembership.ts'

/** Would landing at `target` put the destination inside (or ON) the moving
 *  blocks' own subtrees? Checks both `parentId` (what the moved blocks would
 *  be reparented under) and, for `before`/`after`, the anchor `siblingId` —
 *  pasting relative to a sibling that is itself one of the blocks being
 *  moved is just as incoherent as reparenting into the subtree, since that
 *  anchor is about to move too. */
const isCycleTarget = async (
  repo: Repo,
  target: PasteMoveTarget,
  movingIds: ReadonlySet<string>,
): Promise<boolean> => {
  if (target.parentId !== null && await isWithinSubtreeOfAny(repo, target.parentId, movingIds)) {
    return true
  }
  const siblingId = target.position.kind === 'before' || target.position.kind === 'after'
    ? target.position.siblingId
    : undefined
  return siblingId !== undefined && isWithinSubtreeOfAny(repo, siblingId, movingIds)
}

/** Put a claimed register back — but only while it is still ours to give.
 *
 *  Every restore below happens after at least one `await`, and both a cut
 *  and a copy are one keystroke away. Two different things can have
 *  happened in that window, and each needs its own check:
 *
 *   - a newer CUT armed the register. Restoring over it would bury the
 *     user's latest cut and make their next paste copy instead of move.
 *     Caught by the register no longer being empty.
 *   - a COPY replaced the clipboard. That leaves the register `null` —
 *     nothing to detect — yet our claim is stale all the same: its
 *     sentinel describes content the clipboard no longer holds. The
 *     sentinel check on the next paste usually catches that, but not when
 *     the copied text happens to equal the cut's, which would move the old
 *     blocks and swallow the copy. Caught by the clipboard claim moving.
 *
 *  `clipboardClaim` also advances at a cut's ENTRY, so the first case is
 *  strictly covered by the second; both are kept because they fail for
 *  different reasons and the register check is the cheap, obvious one. */
const restoreClaim = (pending: PendingMove, claimAtEntry: number): void => {
  if (getPendingMove() !== null) return
  if (clipboardClaim() !== claimAtEntry) return
  setPendingMove(pending)
}

export const pasteAsMoveImpl = async ({ repo, target, clipboardText }: PasteAsMoveInput): Promise<boolean> => {
  // Claim the register synchronously — see the module doc's opening
  // paragraph for why this must happen before any `await`.
  const pending = getPendingMove()
  if (!pending) return false
  clearPendingMove()
  // Snapshotted in the same synchronous prologue as the claim itself, so
  // it can't miss a write that lands before our first await.
  const claimAtEntry = clipboardClaim()

  // The sentinel first, and before EVERY branch that would preserve the
  // register: it answers "is this cut still valid at all", where the
  // workspace check below only answers "does it apply to THIS paste". A
  // register the sentinel has invalidated must never be restored — with
  // the checks the other way round, cutting in A, copying something else,
  // then pasting in B restored a cut the copy had already killed, and
  // claimed "pasted a copy instead" about content the clipboard no longer
  // held.
  if (clipboardText !== pending.clipboardText) {
    return false
  }

  if (pending.workspaceId !== repo.activeWorkspaceId) {
    restoreClaim(pending, claimAtEntry)
    showInfo("Can't move blocks across workspaces — pasted a copy instead")
    return false
  }

  try {
    const liveIds = await liveBlockIds(repo, pending.blockIds)
    if (liveIds.length === 0) return false // nothing left to move — fall back to a text paste

    const movingIds = new Set(liveIds)
    if (await isCycleTarget(repo, target, movingIds)) {
      restoreClaim(pending, claimAtEntry)
      showError("Can't paste here — it's inside the block(s) you cut")
      return true
    }

    const result = await moveBlocksTo(repo, liveIds, target)
    if (liveIds.length < pending.blockIds.length) {
      const skipped = pending.blockIds.length - liveIds.length
      showSuccess(
        `Moved ${result.moved} block${result.moved === 1 ? '' : 's'} — `
        + `${skipped} ${skipped === 1 ? 'was' : 'were'} already deleted and skipped`,
      )
    }
  } catch (error) {
    if (error instanceof PartialMoveError) {
      const movedIds = new Set(error.movedIds)
      restoreClaim({ ...pending, blockIds: pending.blockIds.filter(id => !movedIds.has(id)) }, claimAtEntry)
    } else {
      // Nothing committed — either a pre-move read (`liveBlockIds`, the
      // cycle probe) rejected, or `moveBlocksTo` failed before its first
      // tx. Either way the blocks are exactly where the cut left them, so
      // the claim goes back unchanged rather than being swallowed: a
      // dropped register here would send the NEXT paste down the text
      // path, duplicating the still-present originals.
      restoreClaim(pending, claimAtEntry)
    }
    showError(error instanceof Error ? error.message : 'Failed to move blocks')
    return true
  }
  return true
}
