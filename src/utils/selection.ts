import { Block } from '@/data/internals/block'
import type { Repo } from '@/data/internals/repo'
import { selectionStateProp, topLevelBlockIdProp, focusedBlockIdProp, isCollapsedProp } from '@/data/properties'

/** Returns visible block ids in document order under the panel's
 *  top-level block. Walks the subtree depth-first, skipping the
 *  children of any collapsed block (except the top-level block itself,
 *  which always exposes its children regardless of its own collapsed
 *  state).
 *
 *  Reads from cache after a single subtree hydration. Falls back to
 *  the empty list if the subtree isn't reachable. */
export async function getAllVisibleBlockIdsInOrder(
  topLevelBlock: Block,
): Promise<string[]> {
  const repo = topLevelBlock.repo
  await repo.load(topLevelBlock.id, {descendants: true})

  const out: string[] = []
  const walk = (block: Block, isTopLevel: boolean) => {
    out.push(block.id)
    const collapsed = block.peekProperty(isCollapsedProp) ?? false
    // The top-level block always exposes children even if collapsed —
    // collapsing the root would hide everything from the panel.
    if (collapsed && !isTopLevel) return
    if (!repo.cache.areChildrenLoaded(block.id)) return
    for (const child of block.children) walk(child, false)
  }
  walk(topLevelBlock, true)
  return out
}

/** Returns the visible block immediately after `current` in document
 *  order under `topLevelBlockId`. Returns null if `current` is the
 *  last visible block. */
export const nextVisibleBlock = async (
  current: Block,
  topLevelBlockId: string,
): Promise<Block | null> => {
  const repo = current.repo
  const topLevelBlock = repo.block(topLevelBlockId)
  const orderedIds = await getAllVisibleBlockIdsInOrder(topLevelBlock)
  const idx = orderedIds.indexOf(current.id)
  if (idx === -1 || idx === orderedIds.length - 1) return null
  return repo.block(orderedIds[idx + 1])
}

/** Returns the visible block immediately before `current` in document
 *  order under `topLevelBlockId`. Returns null if `current` is the
 *  first visible block (typically the top-level itself). */
export const previousVisibleBlock = async (
  current: Block,
  topLevelBlockId: string,
): Promise<Block | null> => {
  const repo = current.repo
  const topLevelBlock = repo.block(topLevelBlockId)
  const orderedIds = await getAllVisibleBlockIdsInOrder(topLevelBlock)
  const idx = orderedIds.indexOf(current.id)
  if (idx <= 0) return null
  return repo.block(orderedIds[idx - 1])
}

/** Last visible descendant of `block` (deepest, last child of last
 *  child, etc.). Used by keyboard navigation that needs to land on
 *  the bottom of an expanded subtree. Returns the input block if it
 *  has no expanded children. */
export const getLastVisibleDescendant = async (block: Block): Promise<Block> => {
  const repo = block.repo
  await repo.load(block.id, {descendants: true})
  let current = block
  while (true) {
    const collapsed = current.peekProperty(isCollapsedProp) ?? false
    if (collapsed && current.id !== block.id) return current
    if (!repo.cache.areChildrenLoaded(current.id)) return current
    const children = current.children
    if (children.length === 0) return current
    current = children[children.length - 1]
  }
}

/** Walks ancestors via cache snapshots and returns the topmost block
 *  reachable. Used by some shortcut handlers that need to jump to
 *  the workspace root. */
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

/** Range selection between two block ids inside the visible-blocks
 *  document order. Returns the range, validated for hierarchy rules.
 *  Falls back to whichever endpoint is found if either is missing
 *  from the visible list. */
export async function getBlocksInRange(
  startBlockId: string,
  endBlockId: string,
  orderedVisibleBlockIds: string[],
  repo: Repo,
): Promise<string[]> {
  const startIndex = orderedVisibleBlockIds.indexOf(startBlockId)
  const endIndex = orderedVisibleBlockIds.indexOf(endBlockId)

  if (startIndex === -1 || endIndex === -1) {
    console.warn(
      '[getBlocksInRange] Start or end block ID not found in visible blocks list.',
      {startBlockId, endBlockId, orderedVisibleBlockIds},
    )
    const range: string[] = []
    if (startIndex !== -1) range.push(startBlockId)
    if (endIndex !== -1 && startBlockId !== endBlockId) range.push(endBlockId)
    return validateSelectionHierarchy(Array.from(new Set(range)), repo)
  }

  const [minIndex, maxIndex] = [Math.min(startIndex, endIndex), Math.max(startIndex, endIndex)]
  const rangeIds = orderedVisibleBlockIds.slice(minIndex, maxIndex + 1)

  return validateSelectionHierarchy(rangeIds, repo)
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

  const orderedIds = await getAllVisibleBlockIdsInOrder(repo.block(topLevelBlockId))
  const rangeIds = await getBlocksInRange(currentAnchor, targetBlockId, orderedIds, repo)

  await uiStateBlock.set(selectionStateProp, {
    selectedBlockIds: rangeIds,
    anchorBlockId: currentAnchor,
  })
  await uiStateBlock.set(focusedBlockIdProp, targetBlockId)
}
