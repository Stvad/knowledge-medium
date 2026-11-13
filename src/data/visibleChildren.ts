import type { BlockData, Tx } from '@/data/api'
import { unlistedIndexAmong } from '@/data/orderKey'
import {
  childrenViewIn,
  NO_PROPERTY_DISPLAY_SCOPE,
  type PropertyDisplayScopeLevels,
} from '@/data/propertyDisplayMode'

/**
 * The visible / outline view of a parent's children: the list a surface with
 * `scope` draws (`childrenViewIn` — the parent's own display setting over the
 * scope). Named counterpart to the raw `tx.childrenOf`, whose default returns
 * EVERY child — the structural everything-view. Without a scope the view is
 * mode `none`: every recognized property row left out, the outline before
 * property rows.
 *
 * Reach for this in outline / movement / display code: every gesture resolves
 * its anchors against the sibling list the CALLER sees, so a hidden row can
 * neither absorb nor deflect a gesture, and a drawn one is an ordinary row.
 * Use the bare `tx.childrenOf` for the structural view — merge/delete,
 * order-key math, machinery surgery.
 *
 * The `block/require-explicit-child-view` lint enforces this choice in
 * pure-display modules; elsewhere the two spellings document intent
 * side by side.
 */
export const visibleChildrenOf = async (
  tx: Tx,
  parentId: string | null,
  workspaceId?: string,
  scope: PropertyDisplayScopeLevels = NO_PROPERTY_DISPLAY_SCOPE,
): Promise<BlockData[]> => {
  // A cell-backed scope is mode `none` whatever the parent says: skip the read.
  const parent = parentId === null || !scope.childBacked ? null : await tx.get(parentId)
  return tx.childrenOf(parentId, workspaceId, {propertyChildren: childrenViewIn(scope, parent)})
}

/** `self`'s siblings as a surface with `scope` draws them, and `self`'s index
 *  on that list. A `self` the drawn list leaves out (the focused row the
 *  outline keeps showing, `BlockChildren`) goes where the outline draws it:
 *  `unlistedIndexAmong`, the rule `BlockChildren` and the selection walkers use. */
export const visibleSiblingsOf = async (
  tx: Tx,
  self: BlockData,
  scope?: PropertyDisplayScopeLevels,
): Promise<{siblings: BlockData[]; index: number}> => {
  const siblings = await visibleChildrenOf(tx, self.parentId, self.workspaceId, scope)
  const listed = siblings.findIndex(sibling => sibling.id === self.id)
  if (listed >= 0) return {siblings, index: listed}
  const index = unlistedIndexAmong(siblings, self)
  return {siblings: [...siblings.slice(0, index), self, ...siblings.slice(index)], index}
}
