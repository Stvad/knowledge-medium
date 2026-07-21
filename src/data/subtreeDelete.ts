import type { BlockData, Tx } from '@/data/api'

/** Soft-delete `rootId` and every descendant, INCLUDING property field/value
 *  rows (machinery traversal — PR #288 §9: a bare delete strands live rows
 *  under a tombstone; the visible-children default would skip hidden field
 *  rows entirely). Iterative — a comment thread under a property value child
 *  is arbitrarily deep user content, so recursion depth is not bounded.
 *
 *  `onDelete`, when supplied, is invoked with each visited block's PRE-delete
 *  `BlockData`, but the callback itself fires AFTER `tx.delete` commits, never
 *  before: a caller's `onDelete` may itself write (e.g. `tx.emitEvent`, which
 *  requires the tx's workspace already pinned by a prior write), and for the
 *  very first node in an otherwise-empty tx nothing pins the workspace until
 *  that node's own `tx.delete` runs.
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
