/**
 * The move-blocks plugin's contribution to `pasteAsMoveVerb`
 * (`@/paste/moveOnPasteVerb.js`) — the write half of "this paste is a
 * cut being completed". Core owns the seam; this is the one place allowed
 * to call `moveBlocksTo` (core can't — see the verb's module doc).
 *
 * The validity question is already answered before we get here: the
 * payload came out of the clipboard content itself
 * (`resolveClipboardPayload`), so if it's present it describes what is on
 * the clipboard right now, by construction. There is no register to claim,
 * nothing to invalidate, and no way for a second paste to race this one
 * into acting on a stale gesture. What remains is genuinely about THIS
 * paste:
 *
 *   - the payload belongs to another workspace — readable, not actionable.
 *   - none of its blocks are still live (all tombstoned since the cut).
 *     When only SOME are, the survivors move and a toast says how many
 *     were skipped, so the paste doesn't silently move fewer than the user
 *     cut.
 *   - the destination is inside (or is) one of the moving subtrees — a
 *     cycle. Refused with a toast and reported "handled", because falling
 *     through to a text paste would parse the cut markdown into brand-new
 *     blocks while the originals still sit where they were.
 *
 * Every one of those simply falls through (or refuses); none of them has
 * any state to put back. That absence is the point — the previous design's
 * restore-the-claim paths were where four review rounds' worth of bugs
 * lived.
 */
import type { Repo } from '@/data/repo.js'
import { liveBlockIds } from '@/data/blockLiveness.js'
import { showError, showInfo, showSuccess } from '@/utils/toast.js'
import type { PasteAsMoveInput, PasteMoveTarget } from '@/paste/moveOnPasteVerb.js'
import { markCutCompleted } from '@/paste/clipboardPayload.js'
import { moveBlocksTo } from './moveBlocks.ts'
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

/** Cuts with a move already running.
 *
 *  A re-entrancy guard, not a claim: `markCutCompleted` only fires once
 *  the move has committed, so two pastes fired inside that window both
 *  resolve the same live cut and both call `moveBlocksTo` — the second
 *  relocating the blocks straight off the destination the first just put
 *  them on. Held for the duration of ONE call and released in a `finally`,
 *  so unlike the register this owns nothing across gestures and has no
 *  hand-back path to get wrong. */
const movesInFlight = new Set<string>()

const inFlightKey = (payload: PasteAsMoveInput['payload']): string =>
  `${payload.workspaceId}\u0000${payload.blockIds.join(',')}`

export const pasteAsMoveImpl = async ({ repo, target, payload }: PasteAsMoveInput): Promise<boolean> => {
  // Synchronous, before any await — two handlers can't both pass this.
  const key = inFlightKey(payload)
  // Reported as handled: the user pressed paste twice and the first one is
  // doing it. Falling through to a text paste instead would insert a
  // duplicate of the blocks that are already on their way.
  if (movesInFlight.has(key)) return true
  movesInFlight.add(key)
  try {
    return await runPasteAsMove({ repo, target, payload })
  } finally {
    movesInFlight.delete(key)
  }
}

const runPasteAsMove = async ({ repo, target, payload }: PasteAsMoveInput): Promise<boolean> => {
  if (payload.workspaceId !== repo.activeWorkspaceId) {
    showInfo("Can't move blocks across workspaces — pasted a copy instead")
    return false
  }

  try {
    // The preflight reads sit INSIDE the try, and it matters: the DOM
    // paste handlers have already called `preventDefault` and invoke this
    // via `void`, so an escaping rejection discards the paste entirely —
    // no move, no text paste, no toast, just an unhandled rejection.
    // (Regressed once already when this function was rewritten; the
    // failure is invisible to a green suite because nothing asserts on a
    // paste that silently did nothing.)
    const liveIds = await liveBlockIds(repo, payload.blockIds)
    if (liveIds.length === 0) return false // nothing left to move — fall back to a text paste

    if (await isCycleTarget(repo, target, new Set(liveIds))) {
      showError("Can't paste here — it's inside the block(s) you cut")
      return true
    }

    const result = await moveBlocksTo(repo, liveIds, target)
    // The cut is spent. The clipboard still carries it (nothing here can
    // rewrite the OS clipboard), so without this a second paste would
    // relocate the same blocks again — from this destination to the next
    // one — and the first paste would look undone. Marked only on full
    // success: a zero-commit or partial failure stays retryable.
    markCutCompleted(payload)
    if (liveIds.length < payload.blockIds.length) {
      const skipped = payload.blockIds.length - liveIds.length
      showSuccess(
        `Moved ${result.moved} block${result.moved === 1 ? '' : 's'} — `
        + `${skipped} ${skipped === 1 ? 'was' : 'were'} already deleted and skipped`,
      )
    }
  } catch (error) {
    // A `PartialMoveError` needs no special handling any more: the
    // clipboard still holds the same payload, so pasting again retries the
    // whole set. The blocks that already landed are found at their new
    // home and moved again — idempotent — rather than the old design's
    // narrow-the-register-to-the-suffix dance, which also got the
    // continuation order wrong.
    showError(error instanceof Error ? error.message : 'Failed to move blocks')
    return true
  }
  return true
}
