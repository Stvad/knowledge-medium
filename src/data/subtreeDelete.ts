import { CORE_BLOCK_DELETED_EVENT, type BlockData, type Tx } from '@/data/api'

/** Soft-delete `rootId` and every descendant, INCLUDING property field/value
 *  rows (machinery traversal — docs/properties-as-blocks-migration.html §9: a bare delete strands live rows
 *  under a tombstone; the visible-children default would skip hidden field
 *  rows entirely). Iterative — a comment thread under a property value child
 *  is arbitrarily deep user content, so recursion depth is not bounded.
 *
 *  `onDelete`, when supplied, is invoked with each visited block's PRE-delete
 *  `BlockData`, but the callback itself fires AFTER `tx.delete`, never before:
 *  a caller's `onDelete` may itself write (e.g. `tx.emitEvent`, which requires
 *  the tx's workspace already pinned by a prior write). The pin, though, is
 *  only guaranteed when the visited node was LIVE — `tx.delete` on an
 *  already-tombstoned node is a no-op that returns BEFORE pinning the
 *  workspace, so a caller whose `onDelete` writes must itself skip tombstones
 *  (guard on the pre-delete `deleted` flag, as `softDeleteSubtree` does) rather
 *  than rely on this delete to pin. For the first LIVE node in an
 *  otherwise-empty tx, that node's own `tx.delete` is what pins the workspace.
 *
 *  No node is read twice: every descendant arrives already hydrated from its
 *  parent's `childrenOf`, so only the ROOT is fetched — and only when a caller
 *  wants the per-node payload. A missing root still surfaces
 *  `BlockNotFoundError` via its own `tx.delete` below (never a silent no-op),
 *  and the `!block.deleted`-style guards callers layer on the payload keep
 *  working because a tombstoned root's `childrenOf` still returns its live
 *  descendants. */
export const deleteSubtreeInTx = async (
  tx: Tx,
  rootId: string,
  onDelete?: (block: BlockData) => void,
): Promise<void> => {
  const seen = new Set<string>()
  const stack: Array<{id: string; data: BlockData | null}> = [
    {id: rootId, data: onDelete ? await tx.get(rootId) : null},
  ]
  while (stack.length > 0) {
    const {id, data} = stack.pop()!
    if (seen.has(id)) continue
    seen.add(id)
    const children = await tx.childrenOf(id, undefined)
    for (const child of children) stack.push({id: child.id, data: child})
    await tx.delete(id)
    if (onDelete && data !== null) onDelete(data)
  }
}

/** `deleteSubtreeInTx` as a deletion of the user's blocks: each block it
 *  tombstones emits `CORE_BLOCK_DELETED_EVENT`, so same-tx consumers react with
 *  the delete — the references plugin inlines a deleted block into the blocks
 *  that link to it instead of leaving them dangling. Any delete that removes
 *  what a user may link to goes through here; only a tidy-up whose links are
 *  carried elsewhere (a fold, announced as a merge) uses the bare walk. A
 *  tombstoned root is skipped: its `tx.delete` pins nothing to emit under. */
export const deleteSubtreeAnnouncedInTx = (tx: Tx, rootId: string): Promise<void> =>
  deleteSubtreeInTx(tx, rootId, block => {
    if (!block.deleted) {
      tx.emitEvent(CORE_BLOCK_DELETED_EVENT, {workspaceId: block.workspaceId, blockId: block.id})
    }
  })
