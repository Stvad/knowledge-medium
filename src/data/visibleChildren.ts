import type { BlockData, Tx } from '@/data/api'
import type { Block } from '@/data/block'
import { childrenViewFor, type ListingSurface } from '@/data/childrenView'
import { childrenViewIn, type PropertyDisplayScopeLevels } from '@/data/propertyDisplayMode'

/**
 * The children a surface DRAWS under a parent. The owner of that list for
 * imperative code: whichever children view answers for the parent on
 * `surface` (`childrenViewFacet`), else the parent's own display setting over
 * the surface's property display (`childrenViewIn`). The outline hooks
 * (`useChildIds`) resolve the default view reactively.
 *
 * Reach for these in anything a gesture drives: every walk and anchor resolves
 * against the list the user is looking at, so a row the surface leaves out can
 * neither absorb nor deflect a gesture, and a drawn property row is an
 * ordinary row. `surface` is required — a caller with no surface says so
 * (`displayScopeOf`), it does not get a default here.
 *
 * A FIXED view is not this: read it by name, `tx.childrenOf(id, ws,
 * {propertyChildren})` / `repo.query.childIds({id, propertyChildren})`.
 */
export const visibleChildIds = async (
  parent: Block,
  surface: ListingSurface,
): Promise<string[]> => {
  const data = parent.peek() ?? await parent.load()
  if (!data) return []
  const ctx = {parent, data, surface}
  return childrenViewFor(ctx).read(ctx).load()
}

/** The property-display view of {@link visibleChildIds} inside a transaction.
 *  A plugin's view is not consulted here: a transaction cannot read a query
 *  handle, so a gesture that walks a plugin's view resolves its anchors
 *  before the transaction. */
export const visibleChildrenOf = async (
  tx: Tx,
  parentId: string | null,
  workspaceId: string | undefined,
  scope: PropertyDisplayScopeLevels,
): Promise<BlockData[]> => {
  // A cell-backed scope is mode `none` whatever the parent says: skip the read.
  const parent = parentId === null || !scope.childBacked ? null : await tx.get(parentId)
  return tx.childrenOf(parentId, workspaceId, {propertyChildren: childrenViewIn(scope, parent)})
}
