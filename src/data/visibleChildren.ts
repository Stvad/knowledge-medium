import type { BlockData, Tx } from '@/data/api'
import type { Block } from '@/data/block'
import { childrenViewFor, type DrawnChild, type ListingSurface } from '@/data/childrenView'
import { childrenViewIn, type PropertyDisplayScopeLevels } from '@/data/propertyDisplayMode'

/**
 * What a surface DRAWS under a parent, in order. The owner of that list for
 * imperative code: whichever children view answers for the parent on
 * `surface` (`childrenViewFacet`), else the parent's own display setting over
 * the surface's property display (`childrenViewIn`). The outline hooks
 * (`useChildIds`) resolve the default view reactively.
 *
 * Reach for these in anything a gesture drives: every walk and anchor resolves
 * against the list the user is looking at, so a row the surface leaves out can
 * neither absorb nor deflect a gesture, and a drawn property row is an
 * ordinary row. `surface` is required — a caller with no surface says so
 * (`listingSurfaceOf`), it does not get a default here.
 *
 * A FIXED view is not this: read it by name, `tx.childrenOf(id, ws,
 * {propertyChildren})` / `repo.query.childIds({id, propertyChildren})`.
 */
export const drawnChildrenOf = async (
  parent: Block,
  surface: ListingSurface,
): Promise<readonly DrawnChild[]> => {
  const data = parent.peek() ?? await parent.load()
  // A parent with no live row has no block setting and no type to answer for.
  if (!data) return parent.repo.query.childIds({id: parent.id, propertyChildren: childrenViewIn(surface.propertyDisplay, null)}).load()
  const ctx = {parent, data, surface}
  return childrenViewFor(ctx).read(ctx).load()
}

/** The blocks of {@link drawnChildrenOf}: what the parent draws in its own
 *  render scope, a nested surface passed over. */
export const visibleChildIds = async (
  parent: Block,
  surface: ListingSurface,
): Promise<string[]> =>
  (await drawnChildrenOf(parent, surface)).filter((child): child is string => typeof child === 'string')

/** The transaction-local property-display list for writes without a drawn anchor. */
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
