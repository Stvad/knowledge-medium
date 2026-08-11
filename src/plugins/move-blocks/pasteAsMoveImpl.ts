/**
 * The move-blocks plugin's contribution to `pasteAsMoveVerb`
 * (`@/paste/moveOnPasteVerb.js`) — the actual "does this paste complete a
 * pending cut?" decision, plus the write. Core owns the seam and the
 * register; this is the one place that's allowed to call `moveBlocksTo`
 * (core can't — see the verb's module doc).
 *
 * Validity (ALL must hold, else the register is stale/inapplicable and the
 * caller falls back to an ordinary text paste):
 *   - the register isn't empty
 *   - `pending.workspaceId` matches the paste's `repo.activeWorkspaceId`
 *   - `clipboardText` matches EXACTLY what was written at cut time — this is
 *     the invalidation mechanism: copying anything else (in-app or from
 *     another app) after the cut silently falls back to a text paste
 *   - every `pending.blockIds` entry is still live (not soft-deleted)
 *
 * One more case is checked but is NOT "fall back to text paste": if the
 * destination is one of the moving blocks or inside one of their subtrees,
 * that is a cycle. Falling through to a text paste there would silently
 * DUPLICATE the cut content (parse the cut markdown into brand-new blocks
 * right there) while the original, un-deleted blocks are still sitting
 * wherever they were — worse than doing nothing. So this case refuses with
 * a toast and reports "handled" (no text paste), same as a successful move,
 * but KEEPS the register so the user can aim somewhere valid — dropping it
 * would just defer that same duplication to their next paste.
 */
import type { Repo } from '@/data/repo.js'
import { anyBlockTombstoned } from '@/data/blockLiveness.js'
import { showError } from '@/utils/toast.js'
import { clearPendingMove, getPendingMove } from '@/utils/pendingMove.js'
import type { PasteAsMoveInput, PasteMoveTarget } from '@/paste/moveOnPasteVerb.js'
import { moveBlocksTo } from './moveBlocks.ts'

/** Cache-only ancestor walk: is `candidateId` itself in `movingIds`, or a
 *  descendant of one of them? Loads the ancestor chain first (cheap if
 *  already cached) so `repo.cache` snapshots are populated to walk. Mirrors
 *  `isDescendantOf` in `@/utils/selection.ts` (not exported from there), a
 *  parent-chain walk with a `seen` guard against a corrupt cycle. */
const isWithinMovingSubtree = async (
  repo: Repo,
  candidateId: string,
  movingIds: ReadonlySet<string>,
): Promise<boolean> => {
  if (movingIds.has(candidateId)) return true
  await repo.load(candidateId, { ancestors: true })

  const seen = new Set<string>([candidateId])
  let currentId = repo.block(candidateId).peek()?.parentId ?? null
  while (currentId) {
    if (seen.has(currentId)) return false // cycle guard
    if (movingIds.has(currentId)) return true
    seen.add(currentId)
    currentId = repo.cache.getSnapshot(currentId)?.parentId ?? null
  }
  return false
}

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
  if (target.parentId !== null && await isWithinMovingSubtree(repo, target.parentId, movingIds)) {
    return true
  }
  const siblingId = target.position.kind === 'before' || target.position.kind === 'after'
    ? target.position.siblingId
    : undefined
  return siblingId !== undefined && isWithinMovingSubtree(repo, siblingId, movingIds)
}

export const pasteAsMoveImpl = async ({ repo, target, clipboardText }: PasteAsMoveInput): Promise<boolean> => {
  const pending = getPendingMove()
  if (!pending) return false

  if (
    pending.workspaceId !== repo.activeWorkspaceId
    // Only meaningful if our text actually reached the clipboard. When the
    // write was refused (`clipboardSynced === false`) the clipboard holds
    // someone else's text, so this check would fail every time and
    // downgrade every paste to a duplicating text paste — see
    // `PendingMove.clipboardSynced`.
    || (pending.clipboardSynced && clipboardText !== pending.clipboardText)
    || await anyBlockTombstoned(repo, pending.blockIds)
  ) {
    clearPendingMove()
    return false
  }

  const movingIds = new Set(pending.blockIds)
  if (await isCycleTarget(repo, target, movingIds)) {
    // KEEP the register. Clearing it here would defer the very
    // duplication this branch exists to prevent by exactly one
    // keystroke: with no pending move, the user's next Cmd+V at a valid
    // spot falls back to a text paste, which re-parses the cut markdown
    // into brand-new blocks while the originals — never deleted — are
    // still sitting where they were. Refusing a mis-aimed paste is not a
    // reason to throw away the cut; the user just picks another spot.
    showError("Can't paste here — it's inside the block(s) you cut")
    return true
  }

  try {
    await moveBlocksTo(repo, pending.blockIds, target)
  } catch (error) {
    clearPendingMove()
    showError(error instanceof Error ? error.message : 'Failed to move blocks')
    return true
  }
  clearPendingMove()
  return true
}
