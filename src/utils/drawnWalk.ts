import type { Block } from '@/data/block'
import type { Repo } from '@/data/repo'
import type { BlockData } from '@/data/api'
import { surfaceOwnerFacet, type DrawnChild, type NestedSurface } from '@/data/childrenView'
import type { OutlineSurface } from '@/data/outlineSurface'
import { isCollapsedProp, type FocusedBlockLocation } from '@/data/properties'
import { unlistedIndexAmong } from '@/data/orderKey'
import { drawnChildrenOf } from '@/data/visibleChildren'

/** Whether `block` shows its children on `surface`: not collapsed, or the
 *  scope root of a surface that draws its root open whatever the flag
 *  (`OutlineSurface.scopeRootForcesOpen`). Reads the property synchronously
 *  from cache; assumes the row has been loaded. */
const isExpanded = (block: Block, surface: OutlineSurface): boolean => {
  if (block.id === surface.scopeRootId && surface.scopeRootForcesOpen) return true
  return !(block.peekProperty(isCollapsedProp) ?? false)
}

/** Where `row`, which `listedIds` leaves out, sits among them: the index of
 *  the first listed sibling it sorts before, else `listedIds.length`. The
 *  outline lists the focused row a display mode hides at this index
 *  (`BlockChildren`), so the walkers below step from it the same way. Reads
 *  the siblings from the cache; one not loaded there is passed over. */
export const unlistedSiblingIndex = (
  repo: Repo,
  listedIds: readonly string[],
  row: BlockData,
): number => unlistedIndexAmong(listedIds.map(id => repo.block(id).peek()), row)

/** {@link unlistedSiblingIndex} for a walker, which cannot assume the
 *  siblings are in the cache (a mounted outline has them; the bridge and a
 *  cold walk do not): loads them first. */
export const unlistedSiblingIndexLoaded = async (
  repo: Repo,
  listedIds: readonly string[],
  row: BlockData,
): Promise<number> => {
  await Promise.all(listedIds.map(id => repo.load(id)))
  return unlistedSiblingIndex(repo, listedIds, row)
}

export interface DrawnLocation {
  block: Block
  surface: OutlineSurface
}

/** A crossing separates structural edits: an opaque surface lies between the
 *  endpoints, or the walk entered or left a nested member's subtree. */
export interface DrawnStep {
  block: Block | null
  surface: OutlineSurface
  crossed: boolean
}

type Slot = string | {id: string; nested: NestedSurface} | null

/** Siblings share one list even where a view interleaves local blocks and
 *  members of other scopes. Keep a gap for an opaque or empty surface: its
 *  surrounding blocks cannot be merged across the layout. */
function slotsOf(members: readonly DrawnChild[], withinScope = false): Slot[] {
  const slots: Slot[] = []
  for (const member of members) {
    if (typeof member === 'string') slots.push(member)
    else if (!withinScope && member.members?.length) {
      for (const id of member.members) slots.push({id, nested: member})
    } else slots.push(null)
  }
  return slots
}

/** Only actual children of the owner may share its structural editing root.
 *  A projected member keeps its own boundary even under a shared-root declaration. */
export const memberRootOf = (ownerId: string, nested: NestedSurface, member: Pick<BlockData, 'id' | 'parentId'>): string =>
  nested.scopeRootId === ownerId && member.parentId === ownerId ? ownerId : member.id

async function memberRoot(owner: Block, nested: NestedSurface, id: string): Promise<string> {
  if (nested.scopeRootId !== owner.id) return id
  const member = await owner.repo.load(id)
  return member ? memberRootOf(owner.id, nested, member) : id
}

async function locationAt(parent: DrawnLocation, slot: Exclude<Slot, null>): Promise<DrawnLocation> {
  if (typeof slot === 'string') return {block: parent.block.repo.block(slot), surface: parent.surface}
  return {
    block: parent.block.repo.block(slot.id),
    surface: {
      renderScopeId: slot.nested.renderScopeId,
      propertyDisplay: slot.nested.propertyDisplay ?? parent.surface.propertyDisplay,
      scopeRootId: await memberRoot(parent.block, slot.nested, slot.id),
      scopeRootForcesOpen: false,
    },
  }
}

const ownerOf = (repo: Repo, renderScopeId: string | undefined) =>
  renderScopeId === undefined ? undefined : repo.facetRuntime?.read(surfaceOwnerFacet)({repo, renderScopeId})

/** Declared surfaces participate in their owner's outline. An undeclared
 *  surface (such as an embed) remains an independent DOM outline. */
export function outerRenderScopeId(repo: Repo, renderScopeId: string | undefined): string | undefined {
  const owner = ownerOf(repo, renderScopeId)
  return owner ? outerRenderScopeId(repo, owner.surface.renderScopeId) : renderScopeId
}

/** A nested scope whose root is its owner draws the root in the enclosing scope. */
export const scopeRootRenderScope = (repo: Repo, scopeRootId: string, renderScopeId: string | undefined): string | undefined => {
  const owner = ownerOf(repo, renderScopeId)
  return owner?.blockId === scopeRootId ? owner.surface.renderScopeId : renderScopeId
}

async function declarationOf(repo: Repo, renderScopeId: string | undefined) {
  const owner = ownerOf(repo, renderScopeId)
  if (!owner) return undefined
  const parent = {block: repo.block(owner.blockId), surface: owner.surface}
  const members = await drawnChildrenOf(parent.block, parent.surface)
  const nested = members.find((member): member is NestedSurface =>
    typeof member !== 'string' && member.renderScopeId === renderScopeId)
  return nested ? {nested, parent, members} : null
}

type NestedWriteLocation = NonNullable<Awaited<ReturnType<typeof declarationOf>>> & {
  memberId: string
  projected: boolean
  boundaryId: string
  foreignRootId?: string
}

/** Undefined for the ordinary outline, null for an occurrence whose member is no longer drawn. */
export async function nestedWriteLocation(block: Block, renderScopeId: string | undefined): Promise<NestedWriteLocation | null | undefined> {
  const drawn = await declarationOf(block.repo, renderScopeId)
  if (!drawn) return drawn
  const {nested, parent} = drawn
  const member = nested.members?.includes(block.id)
    ? block.peek() ?? await block.load()
    : (await block.repo.query.ancestors({id: block.id}).load()).ancestors.find(row => nested.members?.includes(row.id))
  if (!member) return null
  const foreign = member.parentId !== parent.block.id
  const projected = foreign || nested.order === 'query'
  const enclosing = foreign ? undefined : await nestedWriteLocation(parent.block, parent.surface.renderScopeId)
  if (enclosing === null) return null
  return {...drawn, memberId: member.id, projected,
    boundaryId: projected ? member.id : memberRootOf(parent.block.id, nested, member),
    foreignRootId: foreign ? member.id : enclosing?.foreignRootId}
}

/** Panel-level dispatch supplies the panel surface even when focus belongs
 *  to a nested occurrence. Use that occurrence's display and collapse policy. */
export async function surfaceForFocus(block: Block, renderScopeId: string, surface: OutlineSurface): Promise<OutlineSurface> {
  if (renderScopeId === surface.renderScopeId) return surface
  const declaration = await declarationOf(block.repo, renderScopeId)
  if (!declaration) return {...surface, renderScopeId}
  return {
    renderScopeId,
    propertyDisplay: declaration.nested.propertyDisplay ?? declaration.parent.surface.propertyDisplay,
    scopeRootId: declaration.parent.block.id,
    scopeRootForcesOpen: false,
  }
}

/** An isolated member bounds a range, including any surfaces owned within it. */
export async function selectionBoundaryOf(block: Block, renderScopeId: string | undefined): Promise<FocusedBlockLocation | null> {
  const declaration = await declarationOf(block.repo, renderScopeId)
  if (!declaration) return null
  const {nested, parent} = declaration
  let id: string | null = block.id
  while (id !== null && !nested.members?.includes(id)) id = (await block.repo.load(id))?.parentId ?? null
  if (id === null) return null
  if (await memberRoot(parent.block, nested, id) === id) {
    return {blockId: id, renderScopeId: nested.renderScopeId}
  }
  return selectionBoundaryOf(parent.block, parent.surface.renderScopeId)
}

/** For a member, only its surface's owner knows its drawn siblings. For a
 *  regular child, the data parent lists them in the current scope. */
async function siblingsOf({block, surface}: DrawnLocation) {
  const declaration = await declarationOf(block.repo, surface.renderScopeId)
  if (declaration?.nested.members?.includes(block.id)) {
    const slots = slotsOf(declaration.members)
    const at = slots.findIndex(slot => slot && typeof slot !== 'string' &&
      slot.nested === declaration.nested && slot.id === block.id)
    const scopeRootId = await memberRoot(declaration.parent.block, declaration.nested, block.id)
    return {parent: declaration.parent, slots, at, listed: true, source: {...surface, scopeRootId}}
  }
  if (block.id === surface.scopeRootId) return null
  const data = block.peek() ?? await block.load()
  if (!data?.parentId) return null
  const parent = {block: block.repo.block(data.parentId), surface}
  const slots = slotsOf(await drawnChildrenOf(parent.block, surface))
  const at = slots.indexOf(block.id)
  if (at >= 0) return {parent, slots, at, listed: true, source: surface}

  // An editor can retain a child hidden by the parent's display setting.
  const ids = slots.filter((slot): slot is string => typeof slot === 'string')
  const index = await unlistedSiblingIndexLoaded(block.repo, ids, data)
  const before = ids[index]
  const last = ids.at(-1)
  const insertion = before !== undefined ? slots.indexOf(before) : last === undefined ? 0 : slots.indexOf(last) + 1
  return {parent, slots, at: insertion, listed: false, source: surface}
}

async function scan(parent: DrawnLocation, slots: readonly Slot[], from: number, direction: 1 | -1, source = parent.surface): Promise<DrawnStep> {
  let crossed = false
  for (let i = from; i >= 0 && i < slots.length; i += direction) {
    const slot = slots[i]
    if (slot === null) {
      crossed = true
      continue
    }
    const location = await locationAt(parent, slot)
    return {...location, crossed: crossed || source.renderScopeId !== location.surface.renderScopeId || source.scopeRootId !== location.surface.scopeRootId}
  }
  return {block: null, surface: parent.surface, crossed: crossed || source.renderScopeId !== parent.surface.renderScopeId}
}

async function edgeChild(location: DrawnLocation, direction: 1 | -1, withinScope = false): Promise<DrawnStep> {
  await location.block.load()
  if (!isExpanded(location.block, location.surface)) return {...location, block: null, crossed: false}
  const slots = slotsOf(await drawnChildrenOf(location.block, location.surface), withinScope)
  return scan(location, slots, direction === 1 ? 0 : slots.length - 1, direction)
}

/** A relative preorder walk. With descend=false, step past the whole current
 *  subtree (for a grid cursor leaving its last row). */
export async function nextDrawnStep(block: Block, surface: OutlineSurface, descend = true): Promise<DrawnStep> {
  let current = {block, surface}
  let crossed = false
  if (descend) {
    const first = await edgeChild(current, 1)
    if (first.block) return first
    crossed = first.crossed
  }
  for (let siblings = await siblingsOf(current); siblings; siblings = await siblingsOf(current)) {
    const next = await scan(siblings.parent, siblings.slots, siblings.at + Number(siblings.listed), 1, siblings.source)
    crossed ||= next.crossed
    if (next.block) return {...next, crossed}
    current = siblings.parent
  }
  return {block: null, surface, crossed}
}

export async function lastDrawnStep(
  block: Block, surface: OutlineSurface, {withinScope = false}: {withinScope?: boolean} = {},
): Promise<DrawnLocation & {crossed: boolean}> {
  let current = {block, surface}
  let crossed = false
  for (;;) {
    const last = await edgeChild(current, -1, withinScope)
    crossed ||= last.crossed
    if (!last.block) return {...current, crossed}
    current = {block: last.block, surface: last.surface}
  }
}

export async function previousDrawnStep(block: Block, surface: OutlineSurface): Promise<DrawnStep> {
  const siblings = await siblingsOf({block, surface})
  if (!siblings) return {block: null, surface, crossed: false}
  const previous = await scan(siblings.parent, siblings.slots, siblings.at - 1, -1, siblings.source)
  const crossed = previous.crossed
  if (!previous.block) return {...siblings.parent, crossed}
  const last = await lastDrawnStep(previous.block, previous.surface)
  return {...last, crossed: crossed || last.crossed}
}

/** After removal prefer the next drawn sibling, then the previous sibling,
 *  then the drawn parent. Several selected siblings can disappear together. */
export async function locationAfterSubtreeRemoval(
  block: Block, surface: OutlineSurface, leaving: ReadonlySet<string> = new Set(),
): Promise<DrawnLocation | null> {
  const siblings = await siblingsOf({block, surface})
  if (!siblings) return null
  const {parent, slots, at, listed} = siblings
  const removedRoots = new Set(leaving).add(block.id)
  const survives = async (candidate: Block): Promise<boolean> => {
    if (removedRoots.has(candidate.id)) return false
    const {ancestors} = await candidate.repo.query.ancestors({id: candidate.id}).load()
    return !ancestors.some(ancestor => removedRoots.has(ancestor.id))
  }
  // If the owner disappears, every occurrence it draws disappears with it.
  if (!await survives(parent.block)) return locationAfterSubtreeRemoval(parent.block, parent.surface, removedRoots)
  const find = async (from: number, direction: 1 | -1): Promise<DrawnLocation | null> => {
    for (let index = from; index >= 0 && index < slots.length; index += direction) {
      const slot = slots[index]
      if (slot == null) continue
      const location = await locationAt(parent, slot)
      // A projected sibling may live anywhere, including under a removed root.
      if (typeof slot === 'string'
        ? !removedRoots.has(slot)
        : await survives(location.block)) return location
    }
    return null
  }
  return await find(at + Number(listed), 1) ?? await find(at - 1, -1) ?? parent
}

export const nextVisibleBlock = async (block: Block, surface: OutlineSurface): Promise<Block | null> =>
  (await nextDrawnStep(block, surface)).block

export const previousVisibleBlock = async (block: Block, surface: OutlineSurface): Promise<Block | null> =>
  (await previousDrawnStep(block, surface)).block

export const getLastVisibleDescendant = async (block: Block, surface: OutlineSurface): Promise<Block> =>
  (await lastDrawnStep(block, surface)).block

export const blockAfterSubtreeRemoval = async (
  block: Block, surface: OutlineSurface, leaving?: ReadonlySet<string>,
): Promise<Block | null> => (await locationAfterSubtreeRemoval(block, surface, leaving))?.block ?? null
