import type { BlockData, Tx } from '@/data/api'

/**
 * The visible / outline view of a parent's children. Named counterpart to
 * the raw `tx.childrenOf`, whose default returns EVERY child — the
 * structural everything-view (PR #288/#386).
 *
 * Today this filters EVERY recognized property row, not only hidden-tier
 * ones — an accepted interim until the tier-aware predicate lands. Read an
 * exclusion here as "machinery, for now", not as "property rows are
 * machinery".
 *
 * Reach for this in outline / movement / display code: §10's movement rule
 * is that every gesture resolves its anchors against the sibling list the
 * CALLER sees, so a hidden row can neither absorb nor deflect a gesture.
 * Use the bare `tx.childrenOf` for the structural view — copy/merge/delete,
 * order-key math, machinery surgery, and programmatic callers (agent
 * bridge, plugins) for whom a deliberate move of machinery just works.
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
