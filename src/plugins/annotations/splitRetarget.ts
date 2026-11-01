/**
 * A split cuts a block's text into pieces on separate blocks
 * (`CORE_BLOCK_SPLIT_EVENT`). A thread follows its quote when the quote sat
 * exactly, and wholly, inside one piece: its target becomes that piece's block
 * and its anchor is captured again in the piece's text, so it stays exact. This
 * runs in the split's own transaction, so one undo reverts both.
 *
 * Every other thread stays as it was. A quote across the cut is in neither
 * block, so it goes stale; a moved anchor's position was never confirmed, so
 * it is not carried anywhere.
 */

import {
  CORE_BLOCK_SPLIT_EVENT,
  defineSameTxProcessor,
  propertyValue,
  type BlockReference,
  type CoreBlockSplitEvent,
  type SameTxCtx,
} from '@/data/api'
import {captureAnchor, resolveAnchor, type RangeAnchor} from './anchor.ts'
import {anchorFieldValues, annotationTargetProp, threadAnchorOf, threadTargetEdge, threadTargetIdOf} from './schema.ts'

export const FOLLOW_SPLIT_PROCESSOR = 'annotations.followSplit'

/** Where a thread anchored by `anchor` belongs once `split` has run, or null
 *  when it stays as it is. */
export const anchorAfterSplit = (
  split: Pick<CoreBlockSplitEvent, 'content' | 'pieces'>,
  anchor: RangeAnchor,
): {blockId: string; anchor: RangeAnchor} | null => {
  const resolved = resolveAnchor(split.content, anchor)
  if (resolved.state !== 'exact') return null
  // The piece the quote starts in, since `pieces` are in text order.
  const piece = split.pieces.find(p => resolved.from < p.end)
  if (!piece) return null
  const captured = captureAnchor(
    split.content.slice(piece.start, piece.end), resolved.from - piece.start, resolved.to - piece.start)
  // Captured again in its piece, the quote must be the same text: so it lies
  // wholly inside the piece, and no reference span the piece parses on its own
  // widens it.
  return captured?.quote === anchor.quote ? {blockId: piece.blockId, anchor: captured} : null
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
      set: [propertyValue(annotationTargetProp, followed.blockId), ...anchorFieldValues(followed.anchor)],
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
