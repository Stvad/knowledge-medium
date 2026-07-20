import type { BlockData, Tx } from '@/data/api'

/**
 * The visible / outline view of a parent's children. Named counterpart to
 * the raw `tx.childrenOf`, whose default returns EVERY child — the
 * structural everything-view (PR #288/#386).
 *
 * WHAT "visible" MEANS IS TIER-BASED, and only half of that is built.
 * The settled display model (§10, doc rev 2026-07-19) is two tiers shown
 * IN PLACE: a NON-hidden property renders at its true outline position as
 * a name/value row and behaves as an ordinary child — it belongs in this
 * list; only HIDDEN-tier rows are filtered, and they rejoin the list for a
 * block that has revealed them. As shipped (slices A/B, every workspace
 * dormant at 'cell') this excludes EVERY recognized field row instead,
 * because no tier information is consulted yet — correct while dormant,
 * and superseded by the tier-aware predicate that lands with slice D.
 * So read an exclusion here as "machinery, for now", NOT as "property
 * rows are machinery": the end state is that most of them are content.
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
