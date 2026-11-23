import { blockChangeCursor } from './blockChangeCursor'
import { ChangeScope, type Tx } from './api'
import { indent, liveChildAt, moveVertical, outdent } from './mutators'
import type { Block } from './block'
import type { SurfaceCarrier } from './outlineSurface'
import { childrenViewFor, surfaceOwnerFacet, listingSurfaceOf, propertyDisplayChildrenView, type ChildrenOrder, type ListingSurface, type DrawnChild, type NestedSurface } from './childrenView'
import { lastDrawnStep, nestedWriteLocation, unlistedSiblingIndexLoaded, type DrawnLocation, type NestedWriteLocation } from '@/utils/drawnWalk'
import type { OutlineSurface } from './outlineSurface'

/** Only a synchronous peek is safe while holding the writer. Async loaders can need that same connection. */
function publication(parent: Block, surface: ListingSurface, slots: readonly DrawnChild[], order: ChildrenOrder | undefined, nested?: NestedSurface) {
  const ids = slots.map(slot => typeof slot === 'string' ? slot : null)
  return () => {
    const data = parent.peek()
    if (!data) return false
    const ctx = {parent, data, surface}
    const view = childrenViewFor(ctx)
    const children = view.read(ctx).peek?.()
    const mounted = nested && children?.find((slot): slot is NestedSurface =>
      typeof slot !== 'string' && slot.renderScopeId === nested.renderScopeId)
    const members = nested ? mounted?.members : children
    return (nested ? mounted?.order : view.order) === order && mounted?.scopeRootId === nested?.scopeRootId &&
      members?.length === ids.length && members.every((slot, i) => (typeof slot === 'string' ? slot : null) === ids[i])
  }
}

interface WriteList {
  current(): boolean
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

/** Only the built-in lists can resolve both the sibling and the cross-parent neighbour inside the mutator. */
async function outlineArgs(block: Block, carrier: SurfaceCarrier) {
  const row = block.peek() ?? await block.load()
  if (!row?.parentId || block.id === carrier.scopeRootId) return null
  if (carrier.renderScopeId && block.repo.facetRuntime?.read(surfaceOwnerFacet)({repo: block.repo, renderScopeId: carrier.renderScopeId})) return null
  const parent = await parentListing(block.repo.block(row.parentId), carrier)
  if (parent?.view !== propertyDisplayChildrenView) return null
  const grandparent = parent.ctx.data.parentId
  if (grandparent && parent.ctx.parent.id !== carrier.scopeRootId &&
      (await parentListing(block.repo.block(grandparent), carrier))?.view !== propertyDisplayChildrenView) return null
  return {id: block.id, propertyDisplay: carrier.propertyDisplay, scopeRootId: carrier.scopeRootId}
}

/** A projected result keeps its own structure when Backspace reaches it in the view. */
export async function refusesMerge(block: Block, carrier: SurfaceCarrier, drawn: NestedWriteLocation | undefined) {
  if (drawn?.memberId === block.id) return drawn.projected
  const row = block.peek() ?? await block.load()
  return !!row?.parentId && (await parentListing(block.repo.block(row.parentId), carrier))?.view.order === 'query'
}

/** A foreign result bounds structural writes to its own subtree, including when the notes also appear as query results. */
async function writeList(block: Block, carrier: SurfaceCarrier, retainHidden = false): Promise<WriteList | null> {
  const drawn = await nestedWriteLocation(block, carrier.renderScopeId)
  if (drawn === null) return null
  const row = block.peek() ?? await block.load()
  if (!row) return null
  const nestedCurrent = drawn && publication(
    drawn.parent.block, drawn.parent.surface, drawn.nested.members!, drawn.nested.order, drawn.nested,
  )
  if (drawn?.memberId === block.id) {
    const {nested, parent} = drawn
    if (drawn.projected) return null
    const members = nested.members!
    return {current: nestedCurrent!, owner: parent.block, members, index: members.indexOf(block.id), order: nested.order ?? 'derived', nested,
      boundaryId: parent.block.id, foreignRootId: drawn.foreignRootId}
  }
  if (!row.parentId || block.id === carrier.scopeRootId) return null
  const owner = block.repo.block(row.parentId)
  const listing = await parentListing(owner, carrier)
  if (!listing) return null
  const {ctx, view} = listing
  let members = await view.read(ctx).load()
  const current = publication(owner, ctx.surface, members, view.order)
  let index = members.indexOf(block.id)
  if (index < 0 && retainHidden && view === propertyDisplayChildrenView) {
    const ids = members as readonly string[]
    index = await unlistedSiblingIndexLoaded(block.repo, ids, row)
    members = [...ids.slice(0, index), block.id, ...ids.slice(index)]
  }
  if (index < 0 || view.order === 'query') return null
  return {current: () => current() && (nestedCurrent?.() ?? true), owner, members, index, order: view.order ?? 'derived', boundaryId: drawn?.boundaryId, foreignRootId: drawn?.foreignRootId}
}

function adjacent(list: WriteList, direction: -1 | 1) {
  const near = list.members[list.index + direction]
  return typeof near === 'string' ? {parentId: list.owner.id, siblingId: near, boundaryId: list.boundaryId, foreignRootId: list.foreignRootId} : null
}

function writeIfDrawn<R>(block: Block, lists: WriteList[], write: (tx: Tx) => Promise<R>) {
  return block.repo.tx(async tx => lists.every(list => list.current()) ? write(tx) : null,
    {scope: ChangeScope.BlockDefault, description: `edit drawn block ${block.id}`})
}

export async function indentDrawnBlock(block: Block, carrier: SurfaceCarrier): Promise<void> {
  const plain = await outlineArgs(block, carrier)
  if (plain) return block.repo.mutate.indent({id: block.id, propertyDisplay: plain.propertyDisplay})
  const changeCursor = await blockChangeCursor(block.repo.db)
  const list = await writeList(block, carrier, true)
  const anchor = list && adjacent(list, -1)
  if (list && anchor) await writeIfDrawn(block, [list], tx => tx.run(indent, {id: block.id, anchor: {...anchor, changeCursor}}))
}

/** True on a move, false at an ordinary boundary, null when the drawn placement refused or expired.
 * Empty Enter supplies its original parent so a stale outdent cannot fall back to a sibling insertion. */
export async function outdentDrawnBlock(
  block: Block, carrier: SurfaceCarrier, expectedParentId?: string | null,
): Promise<boolean | null> {
  const write = (args: Parameters<typeof outdent.apply>[1], lists: WriteList[]) => writeIfDrawn(block, lists, async tx => {
    if (expectedParentId !== undefined && !await liveChildAt(tx, block.id, expectedParentId)) return null
    const moved = await tx.run(outdent, args)
    return moved || (args.anchor ? null : false)
  })
  const plain = await outlineArgs(block, carrier)
  if (plain) return write(plain, [])
  const changeCursor = await blockChangeCursor(block.repo.db)
  const list = await writeList(block, carrier, true)
  if (!list || list.nested) return false
  const parent = list.owner
  if (expectedParentId !== undefined && expectedParentId !== parent.id) return null
  const outer = await writeList(parent, carrier)
  const destination = outer?.nested
  if (parent.id === carrier.scopeRootId && (expectedParentId !== undefined || !destination?.allowsNewMember)) return false
  // The workspace's root list has no parent block to declare a view.
  if (!outer && (list.boundaryId || (await parent.load())?.parentId !== null)) return false
  if (destination?.allowsNewMember?.() === false) return null
  return write({id: block.id, anchor: {
    changeCursor, parentId: outer?.owner.id ?? null, siblingId: parent.id,
    boundaryId: outer?.boundaryId, foreignRootId: outer?.foreignRootId,
  }}, outer ? [list, outer] : [list])
}

export async function moveDrawnBlock(block: Block, carrier: SurfaceCarrier, direction: -1 | 1): Promise<boolean> {
  const plain = await outlineArgs(block, carrier)
  if (plain) return block.repo.mutate.moveVertical({...plain, direction})
  const changeCursor = await blockChangeCursor(block.repo.db)
  const list = await writeList(block, carrier, true)
  if (list?.order !== 'outline') return false
  const anchor = adjacent(list, direction)
  if (anchor) return !!await writeIfDrawn(block, [list], tx => tx.run(moveVertical, {id: block.id, direction, anchor: {...anchor, changeCursor}}))
  // Crossing to a neighbouring parent is allowed only at an actual list edge.
  if (list.members[list.index + direction] !== undefined || list.nested || !carrier.scopeRootId || list.owner.id === carrier.scopeRootId) return false
  const outer = await writeList(list.owner, carrier)
  if (outer?.order !== 'outline') return false
  const neighbour = adjacent(outer, direction)
  return !!neighbour && !!await writeIfDrawn(block, [list, outer], tx => tx.run(moveVertical, {id: block.id, direction, anchor: {...neighbour, changeCursor, fromParentId: list.owner.id}}))
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
  if (drawn === null || await refusesMerge(block, surface, drawn)) return null
  if (drawn?.memberId !== block.id) return undefined
  const {nested, parent} = drawn
  const index = nested.members!.indexOf(block.id)
  // Shared-root members use the ordinary outline merge and empty-block deletion.
  if (nested.scopeRootId === parent.block.id) return undefined
  const siblingId = nested.members![index - 1]
  if (!siblingId || (await block.repo.load(siblingId))?.parentId !== parent.block.id) return null
  const last = await lastDrawnStep(block.repo.block(siblingId), {...surface, scopeRootId: siblingId}, {withinScope: true})
  return {...last, anchor: {parentId: parent.block.id, siblingId, deleteOnly: last.crossed}}
}
