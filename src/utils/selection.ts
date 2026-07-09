import { Block } from '../data/block'
import type { Repo } from '../data/repo'
import {
  type FocusedBlockLocation,
  focusedBlockLocationProp,
  isEditingProp,
  isCollapsedProp,
  peekFocusedBlockLocation,
  sameFocusedBlockLocation,
  selectionStateProp,
} from '@/data/properties'
import { outlineRenderScopeId } from '@/utils/renderScope'
import { ChangeScope } from '@/data/api'
import type { RenderVisibilityPolicy } from '@/types.js'
import {
  areChildrenEffectivelyOpen,
  forceOpenScopeRootPolicy,
} from '@/utils/renderVisibility.js'

/** Reads the effective rendered child visibility from the same policy
 *  `DefaultBlockLayout` consumes. This keeps keyboard traversal aligned
 *  with forced-open reveal paths in nested surfaces. Assumes the row has
 *  already been loaded. */
const isExpanded = (
  block: Block,
  renderVisibilityPolicy: RenderVisibilityPolicy,
): boolean =>
  areChildrenEffectivelyOpen(
    renderVisibilityPolicy,
    block.id,
    block.peekProperty(isCollapsedProp) ?? false,
  )

/** Returns the next visible block in document order under
 *  `scopeRootId` (the surface's visible-subtree root — the panel's zoom
 *  root on the main outline, the shown block in a backlink entry, …),
 *  walking *relatively* — descend into the first child if `current` is
 *  expanded and has children, otherwise climb ancestors looking for a
 *  next sibling. Stops at the scope boundary (`scopeRootId`); returns
 *  null when `current` is the last visible block.
 *
 *  Touches O(depth) blocks (one SQL per parent's child list, all small
 *  + handle-cached) instead of materializing the surface's full
 *  visible-id list. Works correctly inside any surface with an arbitrary
 *  scope root because no global "active panel" state is consulted. */
export const nextVisibleBlock = async (
  current: Block,
  scopeRootId: string,
  renderVisibilityPolicy: RenderVisibilityPolicy = forceOpenScopeRootPolicy(scopeRootId),
): Promise<Block | null> => {
  const repo = current.repo
  await current.load()

  // Step into the first child if expanded.
  if (isExpanded(current, renderVisibilityPolicy)) {
    const childIds = await current.childIds.load()
    if (childIds.length > 0) return repo.block(childIds[0])
  }

  // Climb ancestors looking for a next sibling. Stop at the scope root.
  let walker: Block = current
  while (walker.id !== scopeRootId) {
    const data = walker.peek()
    if (!data || data.parentId === null) return null
    const parentId = data.parentId
    const parent = repo.block(parentId)
    await parent.load()
    const siblingIds = await parent.childIds.load()
    const idx = siblingIds.indexOf(walker.id)
    if (idx !== -1 && idx + 1 < siblingIds.length) {
      return repo.block(siblingIds[idx + 1])
    }
    walker = parent
  }
  return null
}

/** Returns the previous visible block in document order under
 *  `scopeRootId`. Mirror of `nextVisibleBlock`: if `current` has a
 *  previous sibling, descend into that sibling's last visible
 *  descendant; otherwise return the parent. Stops at `scopeRootId`
 *  (returns null when `current` is the surface's scope root). */
export const previousVisibleBlock = async (
  current: Block,
  scopeRootId: string,
  renderVisibilityPolicy: RenderVisibilityPolicy = forceOpenScopeRootPolicy(scopeRootId),
): Promise<Block | null> => {
  if (current.id === scopeRootId) return null
  const repo = current.repo
  await current.load()

  const data = current.peek()
  if (!data || data.parentId === null) return null
  const parentId = data.parentId

  const parent = repo.block(parentId)
  await parent.load()
  const siblingIds = await parent.childIds.load()
  const idx = siblingIds.indexOf(current.id)

  if (idx > 0) {
    // Descend into the previous sibling's last visible descendant.
    return getLastVisibleDescendant(repo.block(siblingIds[idx - 1]), renderVisibilityPolicy)
  }
  // No previous sibling — the parent is the previous visible block.
  // When current is a direct child of scopeRootId, parent === scopeRootId,
  // which is itself the first visible block in the surface.
  return parent
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
 *  Returns null when `current` is the surface's `scopeRootId` (no
 *  meaningful target, the surface is about to be empty), or when the
 *  block is detached from the tree.
 *
 *  Mirrors `walker.findRecoveryAnchor`'s sibling-then-ancestor order
 *  on the data side so the post-delete jump matches the proactive
 *  recovery's choice for the disappear-from-DOM case. */
export const blockAfterSubtreeRemoval = async (
  current: Block,
  scopeRootId: string,
): Promise<Block | null> => {
  if (current.id === scopeRootId) return null
  const repo = current.repo
  await current.load()
  const data = current.peek()
  if (!data || data.parentId === null) return null

  const parent = repo.block(data.parentId)
  await parent.load()
  const siblingIds = await parent.childIds.load()
  const idx = siblingIds.indexOf(current.id)
  if (idx === -1) return parent

  if (idx + 1 < siblingIds.length) return repo.block(siblingIds[idx + 1])
  if (idx - 1 >= 0) return repo.block(siblingIds[idx - 1])
  return parent
}

/** Last visible descendant of `block` (deepest, last child of last
 *  child, etc.). Used by keyboard navigation that needs to land on
 *  the bottom of an expanded subtree. Returns the input block if it
 *  is collapsed or has no children.
 *
 *  Forced-open ids in `renderVisibilityPolicy` ignore their own
 *  `isCollapsedProp`, matching `isExpanded`'s rule. Necessary so vim
 *  `Shift+G` still descends from a focal panel root whose own flag
 *  carries a stale collapsed value, and so promoted backlink/SRS
 *  ancestors reveal the anchor path. Mid-walk collapsed blocks still
 *  terminate the descent unless the surface policy explicitly opens
 *  them. */
export const getLastVisibleDescendant = async (
  block: Block,
  renderVisibilityPolicy: RenderVisibilityPolicy = {},
): Promise<Block> => {
  const repo = block.repo
  await block.load()
  let current = block
  while (true) {
    if (!isExpanded(current, renderVisibilityPolicy)) return current
    const childIds = await current.childIds.load()
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

export const blockIdsInOrderedSelectionRange = (
  orderedLocations: readonly FocusedBlockLocation[],
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
  orderedLocations: readonly FocusedBlockLocation[],
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

  const focusedCandidate = candidates.find(({location}) =>
    sameFocusedBlockLocation(location, currentLocation),
  )
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
  scopeRootId: string,
  repo: Repo,
  renderVisibilityPolicy: RenderVisibilityPolicy = forceOpenScopeRootPolicy(scopeRootId),
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
      walker = await nextVisibleBlock(walker, scopeRootId, renderVisibilityPolicy)
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
      walker = await previousVisibleBlock(walker, scopeRootId, renderVisibilityPolicy)
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
    {startBlockId, endBlockId, scopeRootId},
  )
  const fallback: string[] = []
  if (start.peek()) fallback.push(startBlockId)
  if (end.peek() && startBlockId !== endBlockId) fallback.push(endBlockId)
  return validateSelectionHierarchy(Array.from(new Set(fallback)), repo)
}

/** Extends selection to include blocks in range between current
 *  anchor and target block. Reads selection state + focus from the
 *  UI-state block (sync), computes the range against the visible
 *  document order within the surface's scope root, then writes the
 *  new selection state. */
export async function extendSelection(
  targetBlockId: string,
  uiStateBlock: Block,
  repo: Repo,
  scopeRootId: string | undefined,
  renderVisibilityPolicy?: RenderVisibilityPolicy,
  clearEditing = false,
): Promise<boolean> {
  const currentState = uiStateBlock.peekProperty(selectionStateProp)
  const focusedId = peekFocusedBlockLocation(uiStateBlock)?.blockId

  if (!scopeRootId) return false

  const currentAnchor = currentState?.anchorBlockId || focusedId
  if (!currentAnchor) return false

  const rangeIds = await getBlocksInRange(
    currentAnchor,
    targetBlockId,
    scopeRootId,
    repo,
    renderVisibilityPolicy ?? forceOpenScopeRootPolicy(scopeRootId),
  )

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
      renderScopeId: currentLocation?.renderScopeId ?? outlineRenderScopeId(scopeRootId),
    },
    selectedBlockIds: rangeIds,
    clearEditing,
  })
}
