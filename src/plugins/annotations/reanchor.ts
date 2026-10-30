/**
 * Re-anchoring: an explicit user action that rewrites a thread's anchor from
 * the target's text as of its own transaction. "Confirm position" keeps the
 * quote where a moved anchor now finds it; reselecting points the thread at
 * new text; null anchors it to the whole block.
 */

import {ChangeScope} from '@/data/api'
import type {Repo} from '@/data/repo'
import {captureAnchor, resolveAnchor, type RangeAnchor} from './anchor.ts'
import {anchorFieldProps, anchorFieldValues} from './schema.ts'
import {AnchorChangedError, assertQuotable, threadAndTarget} from './threads.ts'

/** The anchor that confirms `anchor` where it resolves in `content` now: the
 *  same quote, with the position and context it has there. Null once the
 *  quote is stale, or when its new surroundings would widen it (the quote
 *  would then be text the user never confirmed). */
export const confirmedAnchor = (content: string, anchor: RangeAnchor): RangeAnchor | null => {
  const resolved = resolveAnchor(content, anchor)
  if (resolved.state === 'stale') return null
  const confirmed = captureAnchor(content, resolved.from, resolved.to)
  return confirmed?.quote === anchor.quote ? confirmed : null
}

/** Rewrite `threadId`'s anchor to `anchor`, or to the whole block for null, as
 *  one undo step. The new anchor must resolve exact against the target in
 *  this transaction's snapshot, as every anchor write must, so text that
 *  changed after the user looked refuses with `AnchorChangedError` and writes
 *  nothing. */
export const reanchorThread = async (repo: Repo, threadId: string, anchor: RangeAnchor | null): Promise<void> => {
  if (anchor) assertQuotable(anchor)
  await repo.tx(async tx => {
    const {target} = await threadAndTarget(tx, threadId)
    if (anchor && resolveAnchor(target.content, anchor).state !== 'exact') throw new AnchorChangedError()

    await tx.update(threadId, {content: anchor?.quote ?? ''})
    await tx.setProperties(threadId, anchor ? {set: anchorFieldValues(anchor)} : {unset: anchorFieldProps})
  }, {scope: ChangeScope.BlockDefault, description: anchor ? 're-anchor thread' : 'anchor thread to block'})
}
