/**
 * Same-tx processor: when a block is deleted, inline its content into the
 * blocks that referenced it via `((id))` syntax.
 *
 * Without this, deleting a block leaves every `((deletedId))`,
 * `!((deletedId))`, and `[label](((deletedId)))` mark in other blocks
 * pointing at a tombstone — a dangling reference that renders as nothing
 * useful. This processor rewrites those marks in place to the text they
 * displayed (the deleted block's content, or the aliased label) and drops
 * the now-stale block-ref entries from each referrer's `references` array,
 * atomically with the originating delete tx.
 *
 * It watches `CORE_BLOCK_DELETED_EVENT`, emitted by the `core.delete`
 * mutator for each freshly soft-deleted block in the subtree. Same-tx (not
 * post-commit) so the inline lands in the same undo step as the delete and
 * referrers never transiently show a dangling ref. Mirrors the
 * merge-retarget processor's shape (committed-state source lookup +
 * staged-state per-source rewrite).
 *
 * Single pass, like all same-tx processors: if a deleted block's content
 * itself contained a ref to another block deleted in the same tx, the
 * inlined copy keeps that (now-dangling) mark — post-commit reference
 * parsing reconciles the referrer's `references` array from the new
 * content, but it can't re-inline transitively. That's a rare edge (a
 * subtree whose inlined descendants cross-reference each other) and not
 * worth a fixpoint here.
 */

import {
  CORE_BLOCK_DELETED_EVENT,
  defineSameTxProcessor,
  normalizeReferences,
  type BlockData,
  type BlockReference,
  type CoreBlockDeletedEvent,
  type SameTxCtx,
  type Tx,
} from '@/data/api'
import { inlineBlockRefs } from './referenceParser.ts'

export const INLINE_DELETED_BLOCK_REFERENCES_PROCESSOR =
  'references.inlineDeletedBlockReferences'

const SELECT_LIVE_REFERENCE_SOURCE_IDS_SQL = `
  SELECT DISTINCT br.source_id AS id
  FROM block_references br
  JOIN blocks source ON source.id = br.source_id
  WHERE br.workspace_id = ?
    AND br.target_id = ?
    AND source.deleted = 0
  ORDER BY source.order_key, source.id
`

/** True for a `references` entry that came from `((id))` block-ref syntax
 *  in content: those project to `{id, alias: id}` with no `sourceField`
 *  (see the reference parser). Wikilink refs (`alias !== id`) and
 *  property-derived refs (`sourceField` set) to the same id are NOT block
 *  refs — we only rewrote block-ref content, so those entries stay. */
const isContentBlockRefTo = (ref: BlockReference, deletedId: string): boolean =>
  ref.id === deletedId && ref.alias === deletedId && ref.sourceField === undefined

const inlineSource = async (
  tx: Tx,
  sourceId: string,
  deletedId: string,
  inlineContent: string,
): Promise<void> => {
  // Re-read staged state: the source may have been deleted earlier in this
  // same tx (subtree delete) — committed `block_references` still lists it,
  // but there's nothing to inline into a block that's going away.
  const current = await tx.get(sourceId)
  if (current === null || current.deleted) return

  const nextContent = inlineBlockRefs(current.content, deletedId, inlineContent)
  const nextReferences = normalizeReferences(
    current.references.filter(ref => !isContentBlockRefTo(ref, deletedId)),
  )

  const patch: Partial<Pick<BlockData, 'content' | 'references'>> = {}
  if (nextContent !== current.content) patch.content = nextContent
  if (JSON.stringify(nextReferences) !== JSON.stringify(current.references)) {
    patch.references = nextReferences
  }
  if (Object.keys(patch).length === 0) return
  // skipMetadata: this is bookkeeping triggered by someone else's delete,
  // not a user edit of the referrer — don't float it to the top of "recent".
  await tx.update(current.id, patch, {skipMetadata: true})
}

const inlineDeletedBlockReferences = async (
  event: CoreBlockDeletedEvent,
  ctx: SameTxCtx,
): Promise<void> => {
  const sourceRows = await ctx.db.getAll<{id: string}>(
    SELECT_LIVE_REFERENCE_SOURCE_IDS_SQL,
    [event.workspaceId, event.blockId],
  )
  if (sourceRows.length === 0) return

  // Soft-delete leaves `content` intact, so the staged row still has the
  // text to inline. Fall back to empty string if it's somehow gone.
  const deleted = await ctx.tx.get(event.blockId)
  const inlineContent = deleted?.content ?? ''

  for (const {id} of sourceRows) {
    await inlineSource(ctx.tx, id, event.blockId, inlineContent)
  }
}

export const inlineDeletedBlockRefsProcessor = defineSameTxProcessor({
  name: INLINE_DELETED_BLOCK_REFERENCES_PROCESSOR,
  watches: {kind: 'event', events: [CORE_BLOCK_DELETED_EVENT]},
  apply: async (event, ctx) => {
    for (const emitted of event.emittedEvents) {
      await inlineDeletedBlockReferences(
        emitted.payload as CoreBlockDeletedEvent,
        ctx,
      )
    }
  },
})
