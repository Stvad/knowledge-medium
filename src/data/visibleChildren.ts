import type { BlockData, Tx } from '@/data/api'

/**
 * The visible / outline view of a parent's children: recognized property
 * field rows (§9 machinery) excluded. Named counterpart to the raw
 * `tx.childrenOf`, whose default returns EVERY child — the structural
 * everything-view (PR #288/#386).
 *
 * Reach for this in outline / movement / display code so hidden property
 * machinery never leaks into a user-facing traversal (mis-picked as an
 * indent target, rendered as a panel, serialized into the clipboard, …).
 * Use the bare `tx.childrenOf` only when you deliberately want the
 * structural rows — copy/merge/delete, order-key math, machinery surgery.
 *
 * The `block/require-explicit-child-view` lint enforces this choice in
 * pure-display modules; elsewhere the two spellings document intent
 * side by side.
 */
export const visibleChildrenOf = (
  tx: Tx,
  parentId: string | null,
  workspaceId?: string,
): Promise<BlockData[]> =>
  tx.childrenOf(parentId, workspaceId, {hidePropertyChildren: true})
