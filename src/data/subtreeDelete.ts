import type { BlockData, Tx } from '@/data/api'

/** Soft-delete `rootId` and every descendant, INCLUDING property field/value
 *  rows (machinery traversal — PR #288 §9: a bare delete strands live rows
 *  under a tombstone; the visible-children default would skip hidden field
 *  rows entirely). Iterative — a comment thread under a property value child
 *  is arbitrarily deep user content, so recursion depth is not bounded.
 *
 *  `onDelete`, when supplied, is invoked with each visited block's PRE-delete
 *  `BlockData` (one extra `tx.get` per node, read before that node's
 *  `tx.delete`) — but the callback itself fires AFTER `tx.delete` commits,
 *  never before: a caller's `onDelete` may itself write (e.g. `tx.emitEvent`,
 *  which requires the tx's workspace already pinned by a prior write), and
 *  for the very first node in an otherwise-empty tx nothing pins the
 *  workspace until that node's own `tx.delete` runs. Callers that don't need
 *  per-node payloads (the common case) pay only `childrenOf` + `delete` per
 *  node. */
export const deleteSubtreeInTx = async (
  tx: Tx,
  rootId: string,
  onDelete?: (block: BlockData) => void,
): Promise<void> => {
  const stack: string[] = [rootId]
  const seen = new Set<string>()
  while (stack.length > 0) {
    const id = stack.pop()!
    if (seen.has(id)) continue
    seen.add(id)
    const children = await tx.childrenOf(id, undefined, {includePropertyChildren: true})
    for (const child of children) stack.push(child.id)
    const preDelete = onDelete ? await tx.get(id) : null
    await tx.delete(id)
    if (onDelete && preDelete !== null) onDelete(preDelete)
  }
}
