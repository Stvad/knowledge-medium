import { Block } from '../data/block'
import type { Repo } from '../data/repo'
import {
  type FocusedBlockLocation,
  focusedBlockLocationProp,
  isEditingProp,
  isCollapsedProp,
  peekFocusedBlockLocation,
  selectionStateProp,
  uiStateRenderScopeId,
} from '@/data/properties'
import { ChangeScope, type BlockData } from '@/data/api'
import { precedesInTree } from '@/data/treeOrder.js'
import { flushPendingEditorContent } from '@/data/pendingEditorContent'
import { unlistedIndexAmong } from '@/data/orderKey'
import { isDrawnAsPropertyName } from '@/data/drawnSubtree'
import type { OutlineSurface } from '@/data/outlineSurface'
import { visibleChildIds } from '@/data/visibleChildren'

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
const unlistedSiblingIndexLoaded = async (
  repo: Repo,
  listedIds: readonly string[],
  row: BlockData,
): Promise<number> => {
  await Promise.all(listedIds.map(id => repo.load(id)))
  return unlistedSiblingIndex(repo, listedIds, row)
}

/** Returns the next visible block in document order on `surface`,
 *  walking *relatively* — descend into the first child if `current` is
 *  expanded and has children, otherwise climb ancestors looking for a
 *  next sibling. Stops at the scope boundary (`surface.scopeRootId`);
 *  returns null when `current` is the last visible block.
 *
 *  Every child list the walkers in this file read is the one the surface
 *  draws (`visibleChildIds`), so a property row the display mode shows is a
 *  row to land on and one it hides is passed by.
 *
 *  Touches O(depth) blocks (one SQL per parent's child list, all small
 *  + handle-cached) instead of materializing the surface's full
 *  visible-id list. Works correctly inside any surface with an arbitrary
 *  scope root because no global "active panel" state is consulted. */
export const nextVisibleBlock = async (
  current: Block,
  surface: OutlineSurface,
): Promise<Block | null> => {
  const repo = current.repo
  await current.load()

  // Step into the first child if expanded.
  if (isExpanded(current, surface)) {
    const childIds = await visibleChildIds(current, surface.propertyDisplay)
    if (childIds.length > 0) return repo.block(childIds[0])
  }

  // Climb ancestors looking for a next sibling. Stop at the scope root.
  let walker: Block = current
  while (walker.id !== surface.scopeRootId) {
    const data = walker.peek()
    if (!data || data.parentId === null) return null
    const parentId = data.parentId
    const parent = repo.block(parentId)
    // The climb reads the parent's own row next (`walker.peek()`).
    await parent.load()
    const siblingIds = await visibleChildIds(parent, surface.propertyDisplay)
    const idx = siblingIds.indexOf(walker.id)
    const nextIdx = idx !== -1 ? idx + 1 : await unlistedSiblingIndexLoaded(repo, siblingIds, data)
    if (nextIdx < siblingIds.length) {
      return repo.block(siblingIds[nextIdx])
    }
    walker = parent
  }
  return null
}

/** Returns the previous visible block in document order on `surface`.
 *  Mirror of `nextVisibleBlock`: if `current` has a previous sibling,
 *  descend into that sibling's last visible descendant; otherwise return
 *  the parent. Stops at the scope root (returns null when `current` is it). */
export const previousVisibleBlock = async (
  current: Block,
  surface: OutlineSurface,
): Promise<Block | null> => {
  if (current.id === surface.scopeRootId) return null
  const repo = current.repo
  await current.load()

  const data = current.peek()
  if (!data || data.parentId === null) return null
  const parentId = data.parentId

  const parent = repo.block(parentId)
  await parent.load()
  const siblingIds = await visibleChildIds(parent, surface.propertyDisplay)
  const idx = siblingIds.indexOf(current.id)
  const prevIdx = (idx !== -1 ? idx : await unlistedSiblingIndexLoaded(repo, siblingIds, data)) - 1

  if (prevIdx >= 0) {
    // Descend into the previous sibling's last visible descendant.
    return getLastVisibleDescendant(repo.block(siblingIds[prevIdx]), surface)
  }
  // No previous sibling — the parent is the previous visible block.
  // When current is a direct child of the scope root, parent is that root,
  // which is itself the first visible block in the surface.
  return parent
}

/** Where the edit-mode caret goes from `block`: the nearest visible row in
 *  `direction` with text to edit. A row drawn as a property's name is passed
 *  over — it has no editor to hold a caret, and a block left editing there
 *  takes no keys. Anything that moves
 *  the CARET to a neighbour asks this; block-level walks (selection, vim
 *  motion, merge targets) use the plain walkers. */
export const caretNeighbour = async (
  block: Block,
  surface: OutlineSurface,
  direction: 'next' | 'previous',
): Promise<Block | null> => {
  const step = direction === 'next' ? nextVisibleBlock : previousVisibleBlock
  let neighbour = await step(block, surface)
  while (neighbour && await isDrawnAsPropertyName(neighbour, surface)) neighbour = await step(neighbour, surface)
  return neighbour
}

/** Picks the block that should hold focus after `current` and its
 *  entire subtree are removed. Uses the data tree (not the DOM):
 *
 *    1. Next data-sibling — the natural "shift-up" target. When a row
 *       is removed from a list, the row that visually replaces its
 *       position is the next sibling at the same depth.
 *    2. Previous data-sibling — engaged when `current` was the last
 *       sibling at its level.
 *    3. Parent — engaged when `current` is the sole child. After
 *       removal the parent is now empty, and it's the natural place
 *       to land.
 *
 *  Returns null when `current` is the surface's scope root (no
 *  meaningful target, the surface is about to be empty), or when the
 *  block is detached from the tree. A row the surface lists out of its
 *  parent's view (the focused row a display mode hides) counts from the
 *  position the outline draws it at.
 *
 *  `leaving`: the rest of a multi-selection going with `current` (a delete or
 *  a cut of several blocks). Siblings in it are passed over, so the last two
 *  siblings of a list fall back to an earlier one rather than to each other.
 *
 *  Mirrors `walker.findRecoveryAnchor`'s sibling-then-ancestor order
 *  on the data side so the post-delete jump matches the proactive
 *  recovery's choice for the disappear-from-DOM case. */
export const blockAfterSubtreeRemoval = async (
  current: Block,
  surface: OutlineSurface,
  leaving: ReadonlySet<string> = new Set(),
): Promise<Block | null> => {
  if (current.id === surface.scopeRootId) return null
  const repo = current.repo
  await current.load()
  const data = current.peek()
  if (!data || data.parentId === null) return null

  const parent = repo.block(data.parentId)
  await parent.load()
  const siblingIds = await visibleChildIds(parent, surface.propertyDisplay)
  const listedAt = siblingIds.indexOf(current.id)
  const idx = listedAt !== -1 ? listedAt : await unlistedSiblingIndexLoaded(repo, siblingIds, data)

  const next = siblingIds.slice(listedAt !== -1 ? idx + 1 : idx).find(id => !leaving.has(id))
  if (next !== undefined) return repo.block(next)
  const previous = siblingIds.slice(0, idx).reverse().find(id => !leaving.has(id))
  if (previous !== undefined) return repo.block(previous)
  return parent
}

/** Last visible descendant of `block` (deepest, last child of last
 *  child, etc.). Used by keyboard navigation that needs to land on
 *  the bottom of an expanded subtree. Returns the input block if it
 *  does not show children (`isExpanded`) or has none; a collapsed block
 *  mid-walk ends the descent, which is `previousVisibleBlock`'s contract
 *  (don't dive into a collapsed sibling). */
export const getLastVisibleDescendant = async (
  block: Block,
  surface: OutlineSurface,
): Promise<Block> => {
  const repo = block.repo
  await block.load()
  let current = block
  while (true) {
    if (!isExpanded(current, surface)) return current
    const childIds = await visibleChildIds(current, surface.propertyDisplay)
    if (childIds.length === 0) return current
    current = repo.block(childIds[childIds.length - 1])
    await current.load()
  }
}

/** Walks ancestors via cache snapshots and returns the topmost block
 *  reachable. Used by some shortcut handlers that need to jump to
 *  the workspace root. Cache-only; the caller is expected to have
 *  hydrated the chain via `repo.load(id, {ancestors: true})` first. */
export const getRootBlock = (block: Block): Block => {
  const repo = block.repo
  let current: Block = block
  const seen = new Set<string>()
  while (true) {
    if (seen.has(current.id)) return current
    seen.add(current.id)
    const data = current.peek()
    if (!data?.parentId) return current
    const parentSnap = repo.cache.getSnapshot(data.parentId)
    if (!parentSnap) return current
    current = repo.block(data.parentId)
  }
}

/** Cache-only ancestor membership check. Walks parent chain via
 *  cache snapshots; returns true iff `descendant` is reached from
 *  `ancestor` going down (or, equivalently, if `ancestor` is in
 *  `descendant`'s parent chain). */
const isDescendantOf = (descendant: Block, ancestor: Block): boolean => {
  const repo = descendant.repo
  let currentId: string | null | undefined = descendant.peek()?.parentId
  const seen = new Set<string>([descendant.id])
  while (currentId) {
    if (seen.has(currentId)) return false  // cycle guard
    seen.add(currentId)
    if (currentId === ancestor.id) return true
    currentId = repo.cache.getSnapshot(currentId)?.parentId
  }
  return false
}

/** `id`'s chain from its root down to itself, read from the cache (load its
 *  ancestors first), or null when part of it isn't loaded or it cycles. */
const pathFromRoot = (repo: Repo, id: string): BlockData[] | null => {
  const path: BlockData[] = []
  const seen = new Set<string>()
  let current = repo.cache.getSnapshot(id)
  while (current) {
    // Defence in depth: a parent cycle (corrupt rows) would loop forever.
    if (seen.has(current.id)) return null
    seen.add(current.id)
    path.unshift(current)
    if (!current.parentId) return path
    current = repo.cache.getSnapshot(current.parentId)
  }
  return null
}

/** `ids` with `id` inserted before the first of them it renders before,
 *  else appended — so a selection kept in document order stays in it. Copy
 *  and cut read the selection in stored order and rely on that. Loads the
 *  ancestors the comparison reads. */
export async function insertInDocumentOrder(
  ids: readonly string[],
  id: string,
  repo: Repo,
): Promise<string[]> {
  await Promise.all([id, ...ids].map(each => repo.load(each, {ancestors: true})))
  const path = pathFromRoot(repo, id)
  const index = path
    ? ids.findIndex(other => {
      const otherPath = pathFromRoot(repo, other)
      return otherPath !== null && precedesInTree(path, otherPath)
    })
    : -1
  return index === -1 ? [...ids, id] : [...ids.slice(0, index), id, ...ids.slice(index)]
}

/** Validates a set of block ids against hierarchical selection
 *  rules:
 *   - When a block is selected, none of its descendants may be selected
 *   - When a block is selected, none of its ancestors may be selected
 *  Processes ids in input order; the first id wins ties. */
export async function validateSelectionHierarchy(
  selectedIds: string[],
  repo: Repo,
): Promise<string[]> {
  // Hydrate ancestor chains for all selected ids — cheap if cached.
  await Promise.all(selectedIds.map(id => repo.load(id, {ancestors: true})))

  const validatedIds = new Set<string>()
  for (const id of selectedIds) {
    const block = repo.block(id)
    let isValid = true

    for (const validId of validatedIds) {
      const validBlock = repo.block(validId)
      if (isDescendantOf(block, validBlock)) {
        isValid = false
        break
      }
      if (isDescendantOf(validBlock, block)) {
        validatedIds.delete(validId)
      }
    }

    if (isValid) validatedIds.add(id)
  }

  return Array.from(validatedIds)
}

const uniqueBlockIds = (ids: readonly string[]): string[] =>
  Array.from(new Set(ids))

/** One row of a range, in document order. A range is a set of blocks, so a row
 *  whose scope isn't known (a deferred row whose surface doesn't name it) still
 *  belongs; only the anchor search reads the scope, to tell copies of one
 *  block apart. */
export interface SelectionRangeRow {
  blockId: string
  renderScopeId?: string
}

export const blockIdsInOrderedSelectionRange = (
  orderedLocations: readonly SelectionRangeRow[],
  anchorIndex: number,
  targetIndex: number,
): string[] => {
  if (
    anchorIndex < 0 ||
    targetIndex < 0 ||
    anchorIndex >= orderedLocations.length ||
    targetIndex >= orderedLocations.length
  ) return []

  const start = Math.min(anchorIndex, targetIndex)
  const end = Math.max(anchorIndex, targetIndex)
  return uniqueBlockIds(
    orderedLocations.slice(start, end + 1).map(location => location.blockId),
  )
}

export const findBestSelectionAnchorIndex = (
  orderedLocations: readonly SelectionRangeRow[],
  options: {
    anchorBlockId: string
    targetIndex: number
    selectedBlockIds?: readonly string[]
    currentLocation?: FocusedBlockLocation
  },
): number => {
  const {
    anchorBlockId,
    targetIndex,
    selectedBlockIds = [],
    currentLocation,
  } = options
  if (targetIndex < 0 || targetIndex >= orderedLocations.length) return -1

  const candidates = orderedLocations
    .map((location, index) => ({location, index}))
    .filter(({location}) => location.blockId === anchorBlockId)
  if (candidates.length === 0) return -1
  if (candidates.length === 1) return candidates[0].index

  const focusedCandidate = currentLocation?.blockId === anchorBlockId
    ? candidates.find(({location}) => location.renderScopeId === currentLocation.renderScopeId)
    : undefined
  if (focusedCandidate) return focusedCandidate.index

  const selected = new Set(selectedBlockIds)
  const ranked = candidates
    .map(({index}) => {
      const ids = blockIdsInOrderedSelectionRange(orderedLocations, index, targetIndex)
      const overlap = ids.filter(id => selected.has(id)).length
      const extra = ids.length - overlap
      const missing = selectedBlockIds.filter(id => !ids.includes(id)).length
      return {
        index,
        score: overlap * 4 - extra - missing,
      }
    })
    .sort((a, b) => b.score - a.score)

  return ranked[0]?.index ?? candidates[0].index
}

export async function commitSelectionRange(
  options: {
    uiStateBlock: Block
    anchorBlockId: string
    targetLocation: FocusedBlockLocation
    selectedBlockIds: readonly string[]
    clearEditing?: boolean
    description?: string
  },
): Promise<boolean> {
  const {
    uiStateBlock,
    anchorBlockId,
    targetLocation,
    selectedBlockIds,
    clearEditing = false,
    description = 'extend selection',
  } = options
  if (selectedBlockIds.length === 0) return false

  const validatedIds = await validateSelectionHierarchy([...selectedBlockIds], uiStateBlock.repo)
  flushPendingEditorContent()
  await uiStateBlock.repo.tx(async tx => {
    await tx.setProperty(uiStateBlock.id, selectionStateProp, {
      selectedBlockIds: validatedIds,
      anchorBlockId,
    })
    await tx.setProperty(uiStateBlock.id, focusedBlockLocationProp, targetLocation)
    if (clearEditing) {
      await tx.setProperty(uiStateBlock.id, isEditingProp, false)
    }
  }, {scope: ChangeScope.UiState, description})
  return true
}

/** Walk visible blocks from `startBlockId` toward `endBlockId` using
 *  the relative-navigation primitives. Direction is auto-detected by
 *  trying forward first, then backward — endpoints are interchangeable
 *  per the original `getBlocksInRange` contract. Returns the inclusive
 *  range of ids in document order, validated for hierarchy rules.
 *
 *  Falls back to whichever endpoint is reachable when the other one
 *  isn't visible from the start (matches the legacy behavior of
 *  `getBlocksInRange` when one endpoint was missing from the visible
 *  list). */
export async function getBlocksInRange(
  startBlockId: string,
  endBlockId: string,
  surface: OutlineSurface,
  repo: Repo,
): Promise<string[]> {
  if (startBlockId === endBlockId) {
    return validateSelectionHierarchy([startBlockId], repo)
  }

  const start = repo.block(startBlockId)
  const end = repo.block(endBlockId)

  const collectForward = async (): Promise<string[] | null> => {
    const ids: string[] = [startBlockId]
    let walker: Block | null = start
    while (walker) {
      walker = await nextVisibleBlock(walker, surface)
      if (!walker) return null
      ids.push(walker.id)
      if (walker.id === endBlockId) return ids
    }
    return null
  }

  const collectBackward = async (): Promise<string[] | null> => {
    const ids: string[] = [startBlockId]
    let walker: Block | null = start
    while (walker) {
      walker = await previousVisibleBlock(walker, surface)
      if (!walker) return null
      ids.unshift(walker.id)
      if (walker.id === endBlockId) return ids
    }
    return null
  }

  const forward = await collectForward()
  const range = forward ?? await collectBackward()
  if (range) return validateSelectionHierarchy(range, repo)

  // Either endpoint isn't reachable from the other within the current
  // scope; preserve the legacy fallback of returning whichever
  // endpoints we know exist.
  console.warn(
    '[getBlocksInRange] endpoints not connected via visible navigation.',
    {startBlockId, endBlockId, scopeRootId: surface.scopeRootId},
  )
  const fallback: string[] = []
  if (start.peek()) fallback.push(startBlockId)
  if (end.peek() && startBlockId !== endBlockId) fallback.push(endBlockId)
  return validateSelectionHierarchy(Array.from(new Set(fallback)), repo)
}

/** Extends selection to include blocks in range between current
 *  anchor and target block. Reads selection state + focus from the
 *  UI-state block (sync), computes the range against the visible
 *  document order on `surface` (none: nothing to extend over), then writes
 *  the new selection state. With no active selection the range starts at
 *  `originBlockId` when given, else at the focused block. */
export async function extendSelection(
  targetBlockId: string,
  uiStateBlock: Block,
  repo: Repo,
  surface: OutlineSurface | null,
  {
    clearEditing = false,
    originBlockId,
  }: {
    clearEditing?: boolean
    originBlockId?: string
  } = {},
): Promise<boolean> {
  const currentState = uiStateBlock.peekProperty(selectionStateProp)
  const focusedId = peekFocusedBlockLocation(uiStateBlock)?.blockId

  if (!surface) return false

  const currentAnchor = currentState?.anchorBlockId || originBlockId || focusedId
  if (!currentAnchor) return false

  const rangeIds = await getBlocksInRange(currentAnchor, targetBlockId, surface, repo)

  const currentLocation = peekFocusedBlockLocation(uiStateBlock)
  // Returns false when the range resolved empty (commitSelectionRange writes
  // nothing). `clearEditing` folds the isEditing→false write into the same
  // transaction as the selection, so a caller leaving edit mode for block
  // selection never produces a render where the block is both editing and
  // selected.
  return commitSelectionRange({
    uiStateBlock,
    anchorBlockId: currentAnchor,
    targetLocation: {
      blockId: targetBlockId,
      renderScopeId: currentLocation?.renderScopeId ?? uiStateRenderScopeId(uiStateBlock, surface.scopeRootId),
    },
    selectedBlockIds: rangeIds,
    clearEditing,
  })
}
