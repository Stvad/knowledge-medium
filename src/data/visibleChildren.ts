import type { BlockData, Tx } from '@/data/api'
import type { Block } from '@/data/block'
import { childrenViewIn, type PropertyDisplayScopeLevels } from '@/data/propertyDisplayMode'

/**
 * The children a surface DRAWS under a parent: the parent's own display
 * setting over the surface's `scope` (`childrenViewIn`). The owner of that
 * list for imperative code — the outline hooks (`useChildIds`) resolve the
 * same view reactively.
 *
 * Reach for these in anything a gesture drives: every walk and anchor resolves
 * against the list the user is looking at, so a row the surface leaves out can
 * neither absorb nor deflect a gesture, and a drawn property row is an
 * ordinary row. `scope` is required — a caller with no surface says so
 * (`displayScopeOf`), it does not get a default here.
 *
 * A FIXED view is not this: read it by name, `tx.childrenOf(id, ws,
 * {propertyChildren})` / `repo.query.childIds({id, propertyChildren})`.
 */
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

/** {@link visibleChildrenOf} outside a transaction, as ids in
 *  `(orderKey, id)` order. */
export const visibleChildIds = async (
  parent: Block,
  scope: PropertyDisplayScopeLevels,
): Promise<string[]> => {
  const data = scope.childBacked ? await parent.load() : null
  return parent.repo.query.childIds({id: parent.id, propertyChildren: childrenViewIn(scope, data)}).load()
}
