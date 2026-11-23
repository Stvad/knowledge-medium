import { ChangeScope, type BlockData, type Tx } from './api'
import { indent, liveChildAt, moveVertical, outdent, type DrawnAnchor } from './mutators'
import type { Block } from './block'
import type { SurfaceCarrier } from './outlineSurface'
import { childrenViewFor, listingSurfaceOf, propertyDisplayChildrenView, type ChildrenOrder, type DrawnChild, type NestedSurface } from './childrenView'
import { lastDrawnStep, nestedWriteLocation, surfaceOwnerOf, type DrawnLocation, type NestedWriteLocation } from '@/utils/drawnWalk'
import type { OutlineSurface } from './outlineSurface'
import { visibleChildIds } from './visibleChildren'

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

/** A projected result keeps its own structure when Backspace reaches it in the view. */
export async function refusesMerge(block: Block, carrier: SurfaceCarrier, drawn: NestedWriteLocation | undefined) {
  if (drawn?.memberId === block.id) return drawn.projected
  const row = block.peek() ?? await block.load()
  return !!row?.parentId && (await parentListing(block.repo.block(row.parentId), carrier))?.view.order === 'query'
}

type Occurrence = NestedWriteLocation | undefined
type StructuralKey = 'indent' | 'outdent' | -1 | 1

/** Only peek the mounted publication while holding the writer. A loader can need that same connection. */
function publishedSurface(drawn: NestedWriteLocation) {
  const {parent: {block, surface}, nested} = drawn
  const data = block.peek()
  if (!data || surfaceOwnerOf(block.repo, nested.renderScopeId)?.blockId !== block.id) return null
  const ctx = {parent: block, data, surface}
  const current = childrenViewFor(ctx).read(ctx).peek?.()?.find((slot): slot is NestedSurface =>
    typeof slot !== 'string' && slot.renderScopeId === nested.renderScopeId)
  return current?.members && current.order === nested.order && current.scopeRootId === nested.scopeRootId ? current : null
}

interface WriteList {
  owner: Block
  order: ChildrenOrder
  nested?: NestedSurface
  members?: string[]
  previous?: string
  /** Opaque slots bound the run of siblings the mutator may use. */
  blockedBefore?: boolean
  blockedAfter?: boolean
}

function memberList(owner: Block, slots: readonly (DrawnChild | null)[], id: string, order: ChildrenOrder | undefined, nested?: NestedSurface, retained = false): WriteList | null {
  const index = slots.indexOf(id)
  if (order === 'query' || (index < 0 && (!retained || slots.some(slot => typeof slot !== 'string')))) return null
  const left = slots.findLastIndex((slot, i) => i < index && typeof slot !== 'string')
  const right = slots.findIndex((slot, i) => i > index && typeof slot !== 'string')
  const members = slots.slice(left + 1, right < 0 ? undefined : right) as string[]
  const previous = slots[index - 1]
  return {owner, members, previous: typeof previous === 'string' ? previous : undefined, order: order ?? 'derived', nested,
    blockedBefore: left >= 0, blockedAfter: right >= 0}
}

async function writeList(block: Block, carrier: SurfaceCarrier, drawn: Occurrence, tx?: Tx, retained = false): Promise<WriteList | null> {
  const row = await readLive(block, tx)
  if (!row?.parentId) return null
  if (drawn) {
    if (drawn.projected && drawn.memberId === block.id) return null
    if (row.parentId === drawn.parent.block.id) {
      const {nested, parent} = drawn
      let slots: readonly (string | null)[] = nested.members!
      if (tx && nested.order === 'outline') {
        // A foreign projection between own children separates their editing runs.
        const own = new Set((await tx.childrenOf(parent.block.id)).map(child => child.id))
        slots = nested.members!.map(id => own.has(id) ? id : null)
      }
      return memberList(parent.block, slots, block.id, nested.order, nested)
    }
  }
  if (block.id === carrier.scopeRootId) return null
  const owner = block.repo.block(row.parentId)
  const listing = await parentListing(owner, carrier, tx)
  if (!listing) return null
  const {ctx, view} = listing
  if (view === propertyDisplayChildrenView) return {owner, order: 'outline'}
  const handle = view.read(ctx)
  const members = tx ? handle.peek?.() : await handle.load()
  return members ? memberList(owner, members, block.id, view.order, undefined, retained) : null
}

function keyWrite(tx: Tx, block: Block, carrier: SurfaceCarrier, key: StructuralKey, source: WriteList, outer: WriteList | null, anchor?: DrawnAnchor) {
  const args = {id: block.id, propertyDisplay: carrier.propertyDisplay}
  if (key === 'indent') return tx.run(indent, {...args, members: source.members, anchor})
  const scopeRootId = carrier.scopeRootId
  if (key === 'outdent') return tx.run(outdent, {...args, anchor, parentMembers: outer?.members, scopeRootId: outer?.nested?.allowsNewMember ? outer.owner.id : scopeRootId})
  const bounded = source.nested || (key < 0 ? source.blockedBefore : source.blockedAfter) || outer?.order !== 'outline'
  return tx.run(moveVertical, {...args, direction: key, members: source.members, parentMembers: outer?.members, scopeRootId: bounded ? source.owner.id : scopeRootId})
}

/** A sorted Tab can nest under its stale keypress neighbour within the same stored parent, and Undo reverses the indent. */
async function derivedAnchor(key: StructuralKey, list: WriteList, outer: WriteList | null, drawn: Occurrence, surface: SurfaceCarrier): Promise<DrawnAnchor | null> {
  const bounds = {boundaryId: list.nested ? list.owner.id : drawn?.boundaryId, foreignRootId: drawn?.foreignRootId}
  if (key === 'indent' && list.previous) return {...bounds, parentId: list.owner.id, siblingId: list.previous}
  if (key === 'outdent') {
    // Empty Enter needs the ordinary sibling fallback when the parent is already hidden at keypress.
    if (outer && !outer.members && !(await visibleChildIds(outer.owner, listingSurfaceOf(surface))).includes(list.owner.id)) return null
    return {...bounds, parentId: outer?.owner.id ?? null, siblingId: list.owner.id}
  }
  return null
}

/** Find the currently drawn row after a queued indent moves a member into another member's notes. */
async function enclosingMember(tx: Tx, row: BlockData, ownerId: string) {
  // The caller has checked ancestry inside this transaction.
  while (row.parentId !== ownerId) {
    const parent = await tx.parentOf(row.id)
    if (!parent || parent.deleted) return null
    row = parent
  }
  return row.id
}

/** A foreign result bounds structural writes to its own subtree, including when its notes also appear as query results. */
async function editDrawnBlock(block: Block, carrier: SurfaceCarrier, key: StructuralKey, expectedParentId?: string | null) {
  const description = typeof key === 'number' ? moveVertical.describe?.({id: block.id, direction: key}) : `${key} ${block.id}`
  const origin = await nestedWriteLocation(block, carrier.renderScopeId)
  if (origin === null) return false
  const first = await writeList(block, carrier, origin)
  if (!first) return false
  const surface = first.nested ? {...carrier, scopeRootId: first.owner.id} : carrier
  const parent = key !== 'indent' ? await writeList(first.owner, surface, origin) : null
  const derived = first.order === 'derived' || (key === 'outdent' && parent?.order === 'derived')
  const anchor = derived ? await derivedAnchor(key, first, parent, origin, surface) : undefined
  if (anchor === null) return false

  return block.repo.tx(async tx => {
    const row = await readLive(block, tx)
    if (!row || (expectedParentId !== undefined && expectedParentId !== row.parentId)) return null
    const root = first.nested ? first.owner.id : origin?.boundaryId ?? carrier.scopeRootId ?? (first.members && first.owner.id)
    if (!await liveChildAt(tx, block.id, row.parentId, root, origin?.foreignRootId)) return null

    let drawn = origin
    let currentSurface = surface
    const relocated = row.parentId !== first.owner.id
    if (origin) {
      const nested = publishedSurface(origin)
      if (!nested) return null
      const member = first.nested && relocated ? await enclosingMember(tx, row, first.owner.id) : origin.memberId
      if (!member || !nested.members!.includes(member)) return null
      drawn = {...origin, nested, memberId: member}
      if (first.nested && relocated && nested.scopeRootId !== first.owner.id) currentSurface = {...surface, scopeRootId: member}
    } else if (surfaceOwnerOf(block.repo, carrier.renderScopeId)) return null
    const list = await writeList(block, currentSurface, drawn, tx, relocated)
    if (!list || list.order !== first.order) return null
    const outer = key !== 'indent' || relocated ? await writeList(list.owner, currentSurface, drawn, tx) : null
    if (relocated && !outer && list.owner.id !== currentSurface.scopeRootId) return null
    if (key === 'outdent') {
      if (list.nested || (list.owner.id === currentSurface.scopeRootId && (expectedParentId !== undefined || !outer?.nested?.allowsNewMember))) return false
      if (!outer && (drawn || (await tx.get(list.owner.id))?.parentId !== null)) return false
      if (outer?.nested?.allowsNewMember?.() === false) return null
    }
    const moved = await keyWrite(tx, block, currentSurface, key, list, outer, anchor)
    return anchor && moved === false ? null : moved
  }, {scope: ChangeScope.BlockDefault, description})
}

export async function indentDrawnBlock(block: Block, carrier: SurfaceCarrier): Promise<void> {
  await editDrawnBlock(block, carrier, 'indent')
}

/** False permits empty Enter's sibling fallback. An expired occurrence refuses the whole gesture. */
export async function outdentDrawnBlock(block: Block, carrier: SurfaceCarrier, expectedParentId?: string | null): Promise<boolean | null> {
  return await editDrawnBlock(block, carrier, 'outdent', expectedParentId) ?? null
}

export async function moveDrawnBlock(block: Block, carrier: SurfaceCarrier, direction: -1 | 1): Promise<boolean> {
  return !!await editDrawnBlock(block, carrier, direction)
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
