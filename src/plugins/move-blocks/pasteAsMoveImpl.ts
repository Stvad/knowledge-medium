/**
 * The move-blocks plugin's contribution to `pasteAsMoveVerb`
 * (`@/paste/moveOnPasteVerb.js`) — the write half of "this paste is a
 * cut being completed". Core owns the seam; this is the one place allowed
 * to call `moveBlocksTo` (core can't — see the verb's module doc).
 *
 * The validity question is already answered before we get here: the
 * payload came out of the clipboard content itself
 * (see `@/paste/clipboardPayload.js`), so if it's present it describes what is on
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
 * None of them has any state to put back, which is why there are no
 * restore paths here.
 */
import type { Repo } from '@/data/repo.js'
import { liveBlockIds } from '@/data/blockLiveness.js'
import { showError, showInfo, showSuccess } from '@/utils/toast.js'
import type {
  PasteAsMoveInput,
  PasteAsMoveResult,
  PasteMoveTarget,
} from '@/paste/moveOnPasteVerb.js'
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

/** The GESTURE, not the blocks — same key `completedCuts` uses. Keying by
 *  workspace+ids instead would collide a fresh cut of the same blocks with
 *  an older paste still in flight, and silently refuse the newer one. */
const inFlightKey = (payload: PasteAsMoveInput['payload']): string => payload.cutId

export const pasteAsMoveImpl = async ({ repo, target, payload }: PasteAsMoveInput): Promise<PasteAsMoveResult> => {
  // Synchronous, before any await — two handlers can't both pass this.
  const key = inFlightKey(payload)
  // Reported as handled: the user pressed paste twice and the first one is
  // doing it. Falling through to a text paste instead would insert a
  // duplicate of the blocks that are already on their way.
  if (movesInFlight.has(key)) return 'refused'
  movesInFlight.add(key)
  try {
    return await runPasteAsMove({ repo, target, payload })
  } finally {
    movesInFlight.delete(key)
  }
}

const runPasteAsMove = async ({ repo, target, payload }: PasteAsMoveInput): Promise<PasteAsMoveResult> => {
  if (payload.workspaceId !== repo.activeWorkspaceId) {
    // Deliberately does not promise a copy landed. The caller falls
    // through to an ordinary text paste, which for a genuinely EMPTY cut
    // inserts nothing — so claiming a copy was pasted would be a lie in
    // exactly the case the user is least able to explain.
    showInfo("Can't move blocks across workspaces")
    return 'not-a-move'
  }

  try {
    // The preflight reads sit INSIDE the try, and it matters: the DOM
    // paste handlers have already called `preventDefault` and invoke this
    // via `void`, so an escaping rejection discards the paste entirely —
    // no move, no text paste, no toast, just an unhandled rejection.
    const liveIds = await liveBlockIds(repo, payload.blockIds)
    if (liveIds.length === 0) return 'not-a-move' // nothing left — fall back to a text paste

    if (await isCycleTarget(repo, target, new Set(liveIds))) {
      showError("Can't paste here — it's inside the block(s) you cut")
      return 'refused'
    }

    const result = await moveBlocksTo(repo, liveIds, target)
    if (result.moved === 0) {
      // Nothing relocated. WHY decides what the caller should do, and the
      // two reasons want opposite answers:
      //
      //   - every source is tombstoned. The blocks are gone for good, so a
      //     text paste re-creating them is the useful outcome.
      //   - every source is merely ABSENT here — an html cut pasted in a
      //     second tab before those rows synced. They are coming. A text
      //     paste would duplicate them the moment they arrive, while the
      //     cut is still armed, so refuse and let the user retry.
      //
      // Re-read AFTER the move to tell them apart. `moveBlocksTo` skips
      // only rows that are missing or tombstoned, so anything that didn't
      // move is one of those; `liveBlockIds` excludes the tombstones and
      // keeps the merely-absent ("missing ≠ deleted"), which is exactly
      // the split. The pre-move read can't answer this — in it, a block
      // deleted a moment later still looks live.
      const absent = await liveBlockIds(repo, liveIds)
      if (absent.length > 0) {
        showError("Those blocks haven't synced here yet — try again in a moment")
        return 'refused'
      }
      return 'not-a-move'
    }

    // Accounting is against `accountedIds`, which includes blocks pruned
    // away because an ancestor in the same request carried them along —
    // `movedIds` lists only the roots that were placed. `liveBlockIds`
    // deliberately keeps ids that are merely MISSING locally ("missing ≠
    // deleted"), and `moveBlocksTo` skips those inside its transaction —
    // so a payload can move some blocks while another sits unsynced. That
    // is not a finished cut: spending it here would strand the absent
    // block at its old parent once it arrives, with every later paste in
    // this tab downgraded to a copy. Leave such a cut live so a paste
    // after the sync can finish it; re-moving the blocks that already
    // landed is idempotent.
    const accounted = new Set(result.accountedIds)
    const unaccounted = liveIds.filter(id => !accounted.has(id))
    // Re-classify against the tree as it is NOW, not against the pre-move
    // read. An id can go missing between the two for two reasons and only
    // one of them is worth waiting for: a block tombstoned since the read
    // is never coming, so holding the cut open for it means every later
    // paste relocates the blocks that DID move and the first paste looks
    // undone. A merely-absent block will arrive, and the cut should stay
    // live so a paste after the sync can finish it.
    //
    // Degrades rather than throwing, for the same reason `moveBlocksTo`'s
    // own accounting does: every move has already COMMITTED by here, and
    // letting this read reject would hit the catch below and report the
    // paste as `refused` — telling the user nothing happened, leaving the
    // relocated blocks in the live selection, and leaving the cut armed to
    // move them again. Failing to reclassify only leaves the cut
    // retryable, which is the harmless direction.
    let stillComing = unaccounted
    if (unaccounted.length > 0) {
      try {
        stillComing = await liveBlockIds(repo, unaccounted)
      } catch (error) {
        console.warn('[paste-as-move] could not reclassify unaccounted blocks', error)
      }
    }
    if (stillComing.length === 0) markCutCompleted(payload)

    const skipped = payload.blockIds.length - accounted.size
    if (skipped > 0) {
      showSuccess(
        `Moved ${result.moved} block${result.moved === 1 ? '' : 's'} — `
        + `${skipped} ${skipped === 1 ? 'was' : 'were'} skipped`,
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
    return 'refused'
  }
  return 'moved'
}
