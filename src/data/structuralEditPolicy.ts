import { blockChangeCursor } from './blockChangeCursor'
import { ChangeScope, type Mutator, type Tx } from './api'
import { indent, liveChildAt, moveVertical, outdent, type DrawnAnchor } from './mutators'
import type { Block } from './block'
import type { SurfaceCarrier } from './outlineSurface'
import { childrenViewFor, listingSurfaceOf, propertyDisplayChildrenView, type ChildrenOrder, type ListingSurface, type DrawnChild, type NestedSurface } from './childrenView'
import { lastDrawnStep, nestedWriteLocation, surfaceOwnerOf, unlistedSiblingIndexLoaded, type DrawnLocation, type NestedWriteLocation } from '@/utils/drawnWalk'
import type { OutlineSurface } from './outlineSurface'

/** Only a synchronous peek is safe while holding the writer. Async loaders can need that same connection. */
function publication(parent: Block, surface: ListingSurface, slots: readonly DrawnChild[], order: ChildrenOrder | undefined, nested?: NestedSurface) {
  const ids = slots.map(slot => typeof slot === 'string' ? slot : null)
  return () => {
    const data = parent.peek()
    if (!data) return false
    if (nested && surfaceOwnerOf(parent.repo, nested.renderScopeId)?.blockId !== parent.id) return false
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

async function readLive(block: Block, tx?: Tx) {
  if (!tx) return block.peek() ?? block.load()
  const row = await tx.get(block.id)
  return row?.deleted ? null : row
}

async function parentListing(owner: Block, carrier: SurfaceCarrier, tx?: Tx) {
  const data = await readLive(owner, tx)
  if (!data) return null
  const ctx = {parent: owner, data, surface: listingSurfaceOf(carrier)}
  return {ctx, view: childrenViewFor(ctx)}
}

/** Only the built-in lists can resolve both the sibling and the cross-parent neighbour inside the mutator. */
async function usesOutline(block: Block, carrier: SurfaceCarrier, tx?: Tx) {
  const row = await readLive(block, tx)
  if (!row?.parentId || block.id === carrier.scopeRootId) return false
  if (surfaceOwnerOf(block.repo, carrier.renderScopeId)) return false
  const parent = await parentListing(block.repo.block(row.parentId), carrier, tx)
  if (parent?.view !== propertyDisplayChildrenView) return false
  const grandparent = parent.ctx.data.parentId
  if (grandparent && parent.ctx.parent.id !== carrier.scopeRootId &&
      (await parentListing(block.repo.block(grandparent), carrier, tx))?.view !== propertyDisplayChildrenView) return false
  return true
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

interface Placement {
  lists: WriteList[]
  anchor: Omit<DrawnAnchor, 'changeCursor'> & {fromParentId?: string}
}

/** Resolve ordinary neighbours inside the writer. A queued key that lands in a plugin list needs a new gesture. */
async function editDrawnBlock<A, R>(
  block: Block, carrier: SurfaceCarrier, mutator: Mutator<A, R>, args: A,
  place: (list: WriteList) => Promise<Placement | false | null> | Placement | false | null,
  expectedParentId?: string | null,
) {
  let lists: WriteList[] | undefined
  if (!await usesOutline(block, carrier)) {
    const changeCursor = await blockChangeCursor(block.repo.db)
    const list = await writeList(block, carrier, true)
    if (!list) return false
    const placement = await place(list)
    if (!placement) return placement
    lists = placement.lists
    args = {...args, anchor: {...placement.anchor, changeCursor}}
  }
  return block.repo.tx(async tx => {
    const current = lists ? lists.every(list => list.current()) : await usesOutline(block, carrier, tx)
    if (!current) return null
    if (expectedParentId !== undefined && !await liveChildAt(tx, block.id, expectedParentId)) return null
    const moved = await tx.run(mutator, args)
    return lists && moved === false ? null : moved
  }, {scope: ChangeScope.BlockDefault, description: mutator.describe?.(args)})
}

function beside(list: WriteList, direction: -1 | 1): Placement | null {
  const anchor = adjacent(list, direction)
  return anchor && {lists: [list], anchor}
}

export async function indentDrawnBlock(block: Block, carrier: SurfaceCarrier): Promise<void> {
  await editDrawnBlock(block, carrier, indent, {id: block.id, propertyDisplay: carrier.propertyDisplay}, list => beside(list, -1))
}

/** True on a move, false at an ordinary boundary, null when the drawn placement refused or expired.
 * Empty Enter supplies its original parent so a stale outdent cannot fall back to a sibling insertion. */
export function outdentDrawnBlock(block: Block, carrier: SurfaceCarrier, expectedParentId?: string | null): Promise<boolean | null> {
  return editDrawnBlock(block, carrier, outdent, {id: block.id, scopeRootId: carrier.scopeRootId, propertyDisplay: carrier.propertyDisplay}, async list => {
    if (list.nested) return false
    const parent = list.owner
    if (expectedParentId !== undefined && expectedParentId !== parent.id) return null
    const outer = await writeList(parent, carrier)
    const destination = outer?.nested
    if (parent.id === carrier.scopeRootId && (expectedParentId !== undefined || !destination?.allowsNewMember)) return false
    // The workspace's root list has no parent block to declare a view.
    if (!outer && (list.boundaryId || (await parent.load())?.parentId !== null)) return false
    if (destination?.allowsNewMember?.() === false) return null
    return {lists: outer ? [list, outer] : [list], anchor: {
      parentId: outer?.owner.id ?? null, siblingId: parent.id,
      boundaryId: outer?.boundaryId, foreignRootId: outer?.foreignRootId,
    }}
  }, expectedParentId)
}

export async function moveDrawnBlock(block: Block, carrier: SurfaceCarrier, direction: -1 | 1): Promise<boolean> {
  const args = {id: block.id, direction, scopeRootId: carrier.scopeRootId, propertyDisplay: carrier.propertyDisplay}
  return !!await editDrawnBlock(block, carrier, moveVertical, args, async list => {
    if (list.order !== 'outline') return false
    const placement = beside(list, direction)
    if (placement) return placement
    // Crossing to a neighbouring parent is allowed only at an actual list edge.
    if (list.members[list.index + direction] !== undefined || list.nested || !carrier.scopeRootId || list.owner.id === carrier.scopeRootId) return false
    const outer = await writeList(list.owner, carrier)
    if (outer?.order !== 'outline') return false
    const neighbour = adjacent(outer, direction)
    return neighbour && {lists: [list, outer], anchor: {...neighbour, fromParentId: list.owner.id}}
  })
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
