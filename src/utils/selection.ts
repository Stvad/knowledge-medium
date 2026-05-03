import { Block } from '../data/block'
import type { Repo } from '../data/repo'
import { selectionStateProp, topLevelBlockIdProp, focusedBlockIdProp, isCollapsedProp } from '@/data/properties'

/** True if `block` is collapsed *and* the caller cares (i.e. it isn't
 *  the panel's top-level block — the top always exposes children even
 *  if its own collapsed flag is set). Reads the property synchronously
 *  from cache; assumes the row has been loaded. */
const isExpanded = (block: Block, topLevelBlockId: string): boolean => {
  if (block.id === topLevelBlockId) return true
  return !(block.peekProperty(isCollapsedProp) ?? false)
}

/** Returns the next visible block in document order under
 *  `topLevelBlockId`, walking *relatively* — descend into the first
 *  child if `current` is expanded and has children, otherwise climb
 *  ancestors looking for a next sibling. Stops at the panel boundary
 *  (`topLevelBlockId`); returns null when `current` is the last
 *  visible block.
 *
 *  Touches O(depth) blocks (one SQL per parent's child list, all small
 *  + handle-cached) instead of materializing the panel's full
 *  visible-id list. Works correctly inside panels with arbitrary
 *  topLevelBlockId because no global "active panel" state is consulted. */
export const nextVisibleBlock = async (
  current: Block,
  topLevelBlockId: string,
): Promise<Block | null> => {
  const repo = current.repo
  await current.load()

  // Step into the first child if expanded.
  if (isExpanded(current, topLevelBlockId)) {
    const childIds = await current.childIds.load()
    if (childIds.length > 0) return repo.block(childIds[0])
  }

  // Climb ancestors looking for a next sibling. Stop at top-level.
  let walker: Block = current
  while (walker.id !== topLevelBlockId) {
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
 *  `topLevelBlockId`. Mirror of `nextVisibleBlock`: if `current` has a
 *  previous sibling, descend into that sibling's last visible
 *  descendant; otherwise return the parent. Stops at `topLevelBlockId`
 *  (returns null when `current` is the panel's top-level block). */
export const previousVisibleBlock = async (
  current: Block,
  topLevelBlockId: string,
): Promise<Block | null> => {
  if (current.id === topLevelBlockId) return null
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
    return getLastVisibleDescendant(repo.block(siblingIds[idx - 1]))
  }
  // No previous sibling — the parent is the previous visible block,
  // unless the parent is *above* topLevelBlockId (which we never
  // returned next-into anyway). When current is a direct child of
  // topLevelBlockId, parent === topLevelBlockId, which is itself the
  // first visible block in the panel.
  return parent
}

/** Last visible descendant of `block` (deepest, last child of last
 *  child, etc.). Used by keyboard navigation that needs to land on
 *  the bottom of an expanded subtree. Returns the input block if it
 *  is collapsed or has no children. */
export const getLastVisibleDescendant = async (block: Block): Promise<Block> => {
  const repo = block.repo
  await block.load()
  let current = block
  while (true) {
    const collapsed = current.peekProperty(isCollapsedProp) ?? false
    if (collapsed) return current
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
  topLevelBlockId: string,
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
      walker = await nextVisibleBlock(walker, topLevelBlockId)
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
      walker = await previousVisibleBlock(walker, topLevelBlockId)
      if (!walker) return null
      ids.unshift(walker.id)
      if (walker.id === endBlockId) return ids
    }
    return null
  }

  const forward = await collectForward()
  const range = forward ?? await collectBackward()
  if (range) return validateSelectionHierarchy(range, repo)

  // Either endpoint isn't reachable from the other under the current
  // panel; preserve the legacy fallback of returning whichever
  // endpoints we know exist.
  console.warn(
    '[getBlocksInRange] endpoints not connected via visible navigation.',
    {startBlockId, endBlockId, topLevelBlockId},
  )
  const fallback: string[] = []
  if (start.peek()) fallback.push(startBlockId)
  if (end.peek() && startBlockId !== endBlockId) fallback.push(endBlockId)
  return validateSelectionHierarchy(Array.from(new Set(fallback)), repo)
}

/** Extends selection to include blocks in range between current
 *  anchor and target block. Reads selection state + focus from the
 *  UI-state block (sync), computes the range against the visible
 *  document order under the active panel's top-level block, then
 *  writes the new selection state. */
export async function extendSelection(
  targetBlockId: string,
  uiStateBlock: Block,
  repo: Repo,
): Promise<void> {
  const currentState = uiStateBlock.peekProperty(selectionStateProp)
  const focusedBlockId = uiStateBlock.peekProperty(focusedBlockIdProp)
  const topLevelBlockId = uiStateBlock.peekProperty(topLevelBlockIdProp)

  if (!topLevelBlockId) return

  const currentAnchor = currentState?.anchorBlockId || focusedBlockId
  if (!currentAnchor) return

  const rangeIds = await getBlocksInRange(currentAnchor, targetBlockId, topLevelBlockId, repo)

  await uiStateBlock.set(selectionStateProp, {
    selectedBlockIds: rangeIds,
    anchorBlockId: currentAnchor,
  })
  await uiStateBlock.set(focusedBlockIdProp, targetBlockId)
}
