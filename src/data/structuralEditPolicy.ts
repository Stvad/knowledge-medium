import { Block } from './block'
import { isCollapsedProp } from './properties.js'

/**
 * Where a "new block below" gesture (vim `o`, Enter-at-end-of-line)
 * must place the created block so it lands somewhere the user can see.
 *  - `child-first`: insert as the block's first child.
 *  - `sibling-below`: insert as the next sibling.
 */
export type CreateBelowPlacement = 'child-first' | 'sibling-below'

export interface StructuralEditPolicyInput {
  /** Block the structural edit targets. */
  blockId: string
  /** Its data-tree parent (null at the workspace root). */
  parentId: string | null
  /** True when the block has children that are currently shown
   *  (i.e. it has at least one child AND is not collapsed). */
  hasUncollapsedChildren: boolean
  /** Root of the visible subtree this block is rendered within — the
   *  panel's zoom root for the main outline, the shown block for a
   *  backlink entry, the embedded block for an embed, etc. `undefined`
   *  when no scope is known (treated as "no scope root", so nothing is
   *  considered the scope root). */
  scopeRootId: string | undefined
}

/**
 * Scope-relative structural-edit policy for one block. Answers the
 * questions every structural mutation needs ("am I at the visible
 * boundary, and what may I do here?") from a single rule set, instead
 * of each call site re-deriving them from the panel's `topLevelBlockId`.
 *
 * The decisions hinge on whether the block is the *scope root* — the
 * top of the bounded subtree the current surface renders. A scope root
 * has no visible parent or siblings within the surface, so:
 *  - "new block below" must descend into a child (a sibling would land
 *    outside the surface, the classic "invisible sibling" bug);
 *  - indent / outdent / merge-into-previous are no-ops (they would
 *    restructure across the surface boundary).
 *
 * The main outline reaches the same answers it always did, because
 * there the scope root simply *is* `topLevelBlockId`. Nested surfaces
 * (backlinks, embeds) now get correct behaviour for free by declaring
 * their own scope root.
 */
export interface StructuralEditPolicy {
  /** Is this block the root of its render scope? */
  isScopeRoot: boolean
  /** Placement for vim `o` / Enter-at-end. */
  createBelowPlacement: CreateBelowPlacement
  /** May Tab indent this block within the surface? */
  canIndent: boolean
  /** May Shift+Tab outdent this block within the surface? The
   *  fine-grained "already at the boundary" check still lives in the
   *  `core.outdent` mutator (it returns `false` and the caller falls
   *  back); this only gates the scope-root case the mutator can't see. */
  canOutdent: boolean
  /** May Backspace-at-start merge this block into the previous visible
   *  block? False at the scope root, where the previous visible block
   *  is outside the surface. */
  canMergeUp: boolean
}

export const resolveStructuralEditPolicy = (
  {blockId, parentId, hasUncollapsedChildren, scopeRootId}: StructuralEditPolicyInput,
): StructuralEditPolicy => {
  const isScopeRoot = scopeRootId !== undefined && blockId === scopeRootId
  return {
    isScopeRoot,
    createBelowPlacement:
      isScopeRoot || hasUncollapsedChildren ? 'child-first' : 'sibling-below',
    canIndent: !isScopeRoot,
    canOutdent: !isScopeRoot && parentId !== scopeRootId,
    canMergeUp: !isScopeRoot,
  }
}

/**
 * Convenience resolver that reads the inputs `resolveStructuralEditPolicy`
 * needs from a live `Block`, centralizing the load idiom the structural
 * action handlers used to repeat (`load` + `childIds` + `isCollapsed`).
 */
export const structuralEditPolicyForBlock = async (
  block: Block,
  scopeRootId: string | undefined,
): Promise<StructuralEditPolicy> => {
  const data = block.peek() ?? await block.load()
  const childIds = await block.childIds.load()
  const isCollapsed = block.peekProperty(isCollapsedProp) ?? false
  return resolveStructuralEditPolicy({
    blockId: block.id,
    parentId: data?.parentId ?? null,
    hasUncollapsedChildren: childIds.length > 0 && !isCollapsed,
    scopeRootId,
  })
}
