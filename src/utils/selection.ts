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
