/**
 * A split cuts a block's text into pieces on separate blocks
 * (`CORE_BLOCK_SPLIT_EVENT`). A thread follows its quote to the piece holding
 * the text the quote resolves to, in the split's own transaction, so one undo
 * reverts both:
 * - an exact anchor is captured again in that piece's text, so it stays exact;
 * - a moved one changes its target, and its offset only where the old one
 *   would find other text in the piece. Its position was never confirmed, so
 *   it stays flagged there until the user confirms it, as after a merge,
 *   unless the cut left it nothing else to resolve by: then it is captured
 *   again there, exact.
 *
 * A quote across the cut is in neither block, so it stays where it was, as
 * does a stale one.
 */

import {
  CORE_BLOCK_SPLIT_EVENT,
  defineSameTxProcessor,
  propertyValue,
  type BlockReference,
  type CoreBlockSplitEvent,
  type SameTxCtx,
} from '@/data/api'
import {recaptureAnchor, resolveAnchor, type RangeAnchor} from './anchor.ts'
import {anchorFieldValues, annotationTargetProp, threadAnchorOf, threadTargetEdge, threadTargetIdOf} from './schema.ts'

export const FOLLOW_SPLIT_PROCESSOR = 'annotations.followSplit'

export interface FollowedAnchor {
  blockId: string
  /** The anchor to write in the piece; null keeps the one it has. */
  anchor: RangeAnchor | null
}

/** A moved anchor in the piece holding its text: kept while it still finds
 *  that text there, else with its offset moved onto it, so the old offset
 *  cannot land on a repeat with the same context and read as exact there.
 *  Where the cut took every context character that agreed, so that offset
 *  finds nothing, the quote is captured again there instead of going stale on
 *  text that is still whole. Either can make it exact on its own text, which
 *  confirms the position the thread showed before the split.
 *  ACCEPTED: an anchor names no occurrence, so a cut that drops the quote's
 *  context can still make a repeat the better match, flagged as moved. */
const followMoved = (anchor: RangeAnchor, pieceText: string, from: number): RangeAnchor | null => {
  const kept = resolveAnchor(pieceText, anchor)
  if (kept.state !== 'stale' && kept.from === from) return null
  const moved = {...anchor, quoteStart: from}
  if (resolveAnchor(pieceText, moved).state !== 'stale') return moved
  return recaptureAnchor(pieceText, from, anchor.quote) ?? moved
}

/** Where a thread anchored by `anchor` belongs once `split` has run, or null
 *  when it stays as it is. */
export const anchorAfterSplit = (
  split: Pick<CoreBlockSplitEvent, 'content' | 'pieces'>,
  anchor: RangeAnchor,
): FollowedAnchor | null => {
  const resolved = resolveAnchor(split.content, anchor)
  if (resolved.state === 'stale') return null
  // The piece the quote starts in, since `pieces` are in text order.
  const piece = split.pieces.find(p => resolved.from < p.end)
  if (!piece || resolved.to > piece.end) return null
  const pieceText = split.content.slice(piece.start, piece.end)
  if (resolved.state === 'moved') {
    return {blockId: piece.blockId, anchor: followMoved(anchor, pieceText, resolved.from - piece.start)}
  }
  // Null where a reference span the piece parses on its own would widen the
  // quote, which would then be text nobody selected.
  const recaptured = recaptureAnchor(pieceText, resolved.from - piece.start, anchor.quote)
  return recaptured ? {blockId: piece.blockId, anchor: recaptured} : null
}

const LIVE_THREAD_ROOTS_ON_SQL = `
  SELECT DISTINCT edge.source_id AS id
    FROM block_references edge
    JOIN blocks root ON root.id = edge.source_id
   WHERE edge.workspace_id = ? AND edge.target_id = ? AND edge.source_field = ? AND root.deleted = 0
`

const isTargetEdgeTo = (ref: BlockReference, targetId: string): boolean =>
  ref.sourceField === annotationTargetProp.name && ref.id === targetId

const followSplit = async (split: CoreBlockSplitEvent, {db, tx}: SameTxCtx): Promise<void> => {
  const roots = await db.getAll<{id: string}>(
    LIVE_THREAD_ROOTS_ON_SQL, [split.workspaceId, split.blockId, annotationTargetProp.name])
  for (const {id} of roots) {
    const root = await tx.get(id)
    // The edge only finds candidates; the property is the target.
    if (!root || threadTargetIdOf(root) !== split.blockId) continue
    const anchor = threadAnchorOf(root)
    const followed = anchor.kind === 'range' ? anchorAfterSplit(split, anchor) : null
    if (!followed) continue
    // The split's bookkeeping, not an edit of the thread.
    await tx.setProperties(id, {
      set: [
        propertyValue(annotationTargetProp, followed.blockId),
        ...(followed.anchor ? anchorFieldValues(followed.anchor) : []),
      ],
    }, {skipMetadata: true})
    await tx.update(id, {
      references: root.references.map(ref =>
        isTargetEdgeTo(ref, split.blockId) ? threadTargetEdge(followed.blockId) : ref),
    }, {skipMetadata: true})
  }
}

export const followSplitProcessor = defineSameTxProcessor({
  name: FOLLOW_SPLIT_PROCESSOR,
  watches: {kind: 'event', events: [CORE_BLOCK_SPLIT_EVENT]},
  apply: async (event, ctx) => {
    for (const emitted of event.emittedEvents) {
      await followSplit(emitted.payload as CoreBlockSplitEvent, ctx)
    }
  },
})
