import { Block } from './block'
import { ChangeScope } from './api'
import { outdent } from './mutators'
import type { SurfaceCarrier } from './outlineSurface'
import { isCollapsedProp } from './properties.js'
import { childrenViewFor, listingSurfaceOf, propertyDisplayChildrenView, type ChildrenOrder, type DrawnChild, type NestedSurface } from './childrenView'
import { lastDrawnStep, nestedWriteLocation, unlistedSiblingIndexLoaded, type DrawnLocation } from '@/utils/drawnWalk'
import type { OutlineSurface } from './outlineSurface'
import { drawnChildrenOf } from './visibleChildren'

/**
 * Where a "new block below" gesture (vim `o`, Enter-at-end-of-line)
 * must place the created block so it lands somewhere the user can see.
 *  - `child-first`: insert as the block's first child.
 *  - `sibling-below`: insert as the next sibling.
 */
export type CreateBelowPlacement = 'child-first' | 'sibling-below'

/**
 * Where a "new block above" gesture (vim `O`) must place the created
 * block so it lands somewhere the user can see.
 *  - `child-first`: insert as the block's first child (used at the scope
 *    root, where a sibling above would land outside the visible surface).
 *  - `sibling-above`: insert as the previous sibling.
 */
export type CreateAbovePlacement = 'child-first' | 'sibling-above'

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
 * Every rule here is about MOVING structure across the surface boundary
 * — placing, reparenting, or merging a block somewhere the surface
 * cannot render. That's what makes them scope-relative.
 *
 * Deletion is deliberately not in this set — removing a subtree relocates
 * nothing across the boundary, and the inclusion criterion above is
 * exactly "moves structure across the boundary". A `canDelete:
 * !isScopeRoot` rule here once made page deletion unreachable from every
 * UI; don't reintroduce it.
 */
export interface StructuralEditPolicy {
  /** Is this block the root of its render scope? */
  isScopeRoot: boolean
  /** Does the block show at least one child in this scope? */
  hasUncollapsedChildren: boolean
  /** Placement for vim `o` / Enter-at-end. */
  createBelowPlacement: CreateBelowPlacement
  /** Placement for vim `O`. At the scope root a sibling above would land
   *  outside the visible surface (the "invisible block" bug), so it
   *  degenerates to a first child — the only insertion point relative to
   *  the root the surface can actually render. */
  createAbovePlacement: CreateAbovePlacement
  /** May Tab indent this block within the surface? */
  canIndent: boolean
  /** May Shift+Tab outdent this block within the surface? The
   *  fine-grained "already at the boundary" check still lives in the
   *  `core.outdent` mutator (it returns `false` and the caller falls
   *  back); this only gates the scope-root case the mutator can't see. */
  canOutdent: boolean
  /** May Backspace-at-start consume this block — merging it into the
   *  previous visible block, or (when empty) removing it and putting the
   *  cursor there? False at the scope root, where there is no previous
   *  visible block inside the surface for the gesture to land on. Note
   *  this gates the *Backspace* gesture, not deletion in general: an
   *  explicit Delete on the scope root is allowed (see above). */
  canMergeUp: boolean
}

export const resolveStructuralEditPolicy = (
  {blockId, parentId, hasUncollapsedChildren, scopeRootId}: StructuralEditPolicyInput,
): StructuralEditPolicy => {
  const isScopeRoot = scopeRootId !== undefined && blockId === scopeRootId
  return {
    isScopeRoot,
    hasUncollapsedChildren,
    createBelowPlacement:
      isScopeRoot || hasUncollapsedChildren ? 'child-first' : 'sibling-below',
    createAbovePlacement: isScopeRoot ? 'child-first' : 'sibling-above',
    canIndent: !isScopeRoot,
    canOutdent: !isScopeRoot && parentId !== scopeRootId,
    canMergeUp: !isScopeRoot,
  }
}

/**
 * {@link resolveStructuralEditPolicy} for a live `Block`. `carrier` is what
 * the gesture knows of where it ran (its dependencies): "has children" means
 * children that surface draws. It may name no scope root (imperative
 * dispatch), and then no block is treated as one.
 */
export const structuralEditPolicyForBlock = async (
  block: Block,
  carrier: SurfaceCarrier,
): Promise<StructuralEditPolicy> => {
  const data = block.peek() ?? await block.load()
  const drawn = await drawnChildrenOf(block, listingSurfaceOf(carrier))
  const isCollapsed = block.peekProperty(isCollapsedProp) ?? false
  return resolveStructuralEditPolicy({
    blockId: block.id,
    parentId: data?.parentId ?? null,
    hasUncollapsedChildren: drawn.length > 0 && !isCollapsed,
    scopeRootId: carrier.scopeRootId,
  })
}

interface WriteList {
  owner: Block
  members: readonly DrawnChild[]
  index: number
  order: ChildrenOrder
  nested?: NestedSurface
  boundaryId?: string
  foreignRootId?: string
}

async function parentListing(owner: Block, carrier: SurfaceCarrier) {
  const data = owner.peek() ?? await owner.load()
  if (!data) return null
  const ctx = {parent: owner, data, surface: listingSurfaceOf(carrier)}
  return {ctx, view: childrenViewFor(ctx)}
}

/** Same-scope views list own children, which may still be independently selected by a query. */
export async function isSameScopeQueryMember(block: Block, carrier: SurfaceCarrier) {
  const row = block.peek() ?? await block.load()
  return !!row?.parentId && (await parentListing(block.repo.block(row.parentId), carrier))?.view.order === 'query'
}

/** A foreign result bounds structural writes to its own subtree, including when the notes also appear as query results. */
async function writeList(block: Block, carrier: SurfaceCarrier, retainHidden = false): Promise<WriteList | null> {
  const drawn = await nestedWriteLocation(block, carrier.renderScopeId)
  if (drawn === null) return null
  const row = block.peek() ?? await block.load()
  if (!row) return null
  if (drawn?.memberId === block.id) {
    const {nested, parent} = drawn
    if (drawn.projected) return null
    const members = nested.members!
    return {owner: parent.block, members, index: members.indexOf(block.id), order: nested.order ?? 'derived', nested,
      boundaryId: parent.block.id, foreignRootId: drawn.foreignRootId}
  }
  if (!row.parentId || block.id === carrier.scopeRootId) return null
  const owner = block.repo.block(row.parentId)
  const listing = await parentListing(owner, carrier)
  if (!listing) return null
  const {ctx, view} = listing
  let members = await view.read(ctx).load()
  let index = members.indexOf(block.id)
  if (index < 0 && retainHidden && view === propertyDisplayChildrenView) {
    const ids = members as readonly string[]
    index = await unlistedSiblingIndexLoaded(block.repo, ids, row)
    members = [...ids.slice(0, index), block.id, ...ids.slice(index)]
  }
  if (index < 0 || view.order === 'query') return null
  return {owner, members, index, order: view.order ?? 'derived', boundaryId: drawn?.boundaryId, foreignRootId: drawn?.foreignRootId}
}

function adjacent(list: WriteList, direction: -1 | 1) {
  const near = list.members[list.index + direction]
  return typeof near === 'string' ? {parentId: list.owner.id, siblingId: near, boundaryId: list.boundaryId, foreignRootId: list.foreignRootId} : null
}

export async function indentDrawnBlock(block: Block, carrier: SurfaceCarrier): Promise<void> {
  const list = await writeList(block, carrier, true)
  const anchor = list && adjacent(list, -1)
  if (anchor) await block.repo.mutate.indent({id: block.id, anchor})
}

/** True on a move, false at an ordinary boundary, null when the drawn placement refused or expired. */
export async function outdentDrawnBlock(
  block: Block, carrier: SurfaceCarrier, expectedParentId?: string | null, isCurrent?: () => boolean,
): Promise<boolean | null> {
  const list = await writeList(block, carrier, true)
  if (!list || list.nested) return false
  const parent = list.owner
  if (expectedParentId !== undefined && expectedParentId !== parent.id) return null
  const outer = await writeList(parent, carrier)
  // The workspace's root list has no parent block to declare a view.
  if (!outer && (list.boundaryId || parent.id === carrier.scopeRootId || (await parent.load())?.parentId !== null)) return false
  if (outer?.nested?.allowsNewMember?.() === false) return null
  const args = {id: block.id, anchor: {
    parentId: outer?.owner.id ?? null, siblingId: parent.id,
    boundaryId: outer?.boundaryId, foreignRootId: outer?.foreignRootId,
  }}
  const moved = isCurrent === undefined
    ? await block.repo.mutate.outdent(args)
    : await block.repo.tx(async tx => isCurrent() && tx.run(outdent, args),
      {scope: ChangeScope.BlockDefault, description: `outdent ${block.id}`})
  return moved || null
}

export async function moveDrawnBlock(block: Block, carrier: SurfaceCarrier, direction: -1 | 1): Promise<boolean> {
  const list = await writeList(block, carrier, true)
  if (list?.order !== 'outline') return false
  const anchor = adjacent(list, direction)
  if (anchor) return block.repo.mutate.moveVertical({id: block.id, direction, anchor})
  // Crossing to a neighbouring parent is allowed only at an actual list edge.
  if (list.members[list.index + direction] !== undefined || list.nested || !carrier.scopeRootId || list.owner.id === carrier.scopeRootId) return false
  const outer = await writeList(list.owner, carrier)
  if (outer?.order !== 'outline') return false
  const neighbour = adjacent(outer, direction)
  return !!neighbour && block.repo.mutate.moveVertical({id: block.id, direction, anchor: {...neighbour, fromParentId: list.owner.id}})
}

export interface DrawnMergeAnchor {
  parentId: string
  siblingId: string
  /** A crossed surface can supply a focus target after leaf deletion. */
  deleteOnly?: boolean
}

interface MergePlacement extends DrawnLocation {
  anchor: DrawnMergeAnchor
}

/** Undefined keeps the outline's empty-block deletion. Null refuses the gesture before either deletion or merge. */
export async function memberMergePlacement(block: Block, surface: OutlineSurface, location = nestedWriteLocation(block, surface.renderScopeId)): Promise<MergePlacement | null | undefined> {
  const drawn = await location
  if (drawn === null) return null
  if (drawn?.memberId !== block.id) return await isSameScopeQueryMember(block, surface) ? null : undefined
  const {nested, parent} = drawn
  const index = nested.members!.indexOf(block.id)
  if (drawn.projected) return null
  // Shared-root members use the ordinary outline merge and empty-block deletion.
  if (nested.scopeRootId === parent.block.id) return undefined
  const siblingId = nested.members![index - 1]
  if (!siblingId || (await block.repo.load(siblingId))?.parentId !== parent.block.id) return null
  const last = await lastDrawnStep(block.repo.block(siblingId), {...surface, scopeRootId: siblingId}, {withinScope: true})
  return {...last, anchor: {parentId: parent.block.id, siblingId, deleteOnly: last.crossed}}
}
