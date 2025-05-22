import { Block } from '@/data/block';
import { Repo } from '@/data/repo';
import { isCollapsedProp, selectionStateProp, topLevelBlockIdProp, focusedBlockIdProp } from '@/data/properties';

/**
 * Retrieves all visible block IDs in their document order for a given panel.
 * It starts from the panel's top-level block and traverses downwards,
 * skipping children of collapsed blocks, unless the collapsed block is the top-level block.
 * @returns A promise that resolves to an array of visible block IDs in order.
 */
export async function getAllVisibleBlockIdsInOrder(
  topLevelBlock: Block,
): Promise<string[]> {
  const visibleBlockIds: string[] = [];

  async function traverse(block: Block) {
    visibleBlockIds.push(block.id);

    const isCollapsed = (await block.getProperty(isCollapsedProp))?.value
    if (isCollapsed && block.id !== topLevelBlock.id) {
      // If the block is collapsed and it's not the top-level block,
      // we don't traverse its children.
      // If it is the top-level block, we ignore the collapsed state
      // and process its children anyway.
      return;
    }

    const children = await block.children(); // Assumes children are already sorted by order
    for (const child of children) {
      await traverse(child);
    }
  }

  await traverse(topLevelBlock);
  return visibleBlockIds;
}

/**
 * Given a start block ID, an end block ID, and a list of all visible block IDs
 * in document order, returns an array of block IDs that fall within that range (inclusive).
 * The returned IDs are validated according to hierarchical selection rules.
 * @param startBlockId The ID of the first block in the desired range.
 * @param endBlockId The ID of the last block in the desired range.
 * @param orderedVisibleBlockIds An array of all visible block IDs, in document order.
 * @param repo Repository instance to find blocks
 * @returns An array of block IDs representing the range, validated for hierarchy rules.
 */
export async function getBlocksInRange(
  startBlockId: string,
  endBlockId: string,
  orderedVisibleBlockIds: string[],
  repo: Repo,
): Promise<string[]> {
  const startIndex = orderedVisibleBlockIds.indexOf(startBlockId);
  const endIndex = orderedVisibleBlockIds.indexOf(endBlockId);

  if (startIndex === -1 || endIndex === -1) {
    console.warn('[getBlocksInRange] Start or end block ID not found in visible blocks list.', { startBlockId, endBlockId, orderedVisibleBlockIds });
    // Fallback: if one is found, return it. If both, and different, return both.
    // This is a minimal recovery. Ideally, both should always be in the list if they are part of a valid selection action.
    const range: string[] = [];
    if (startIndex !== -1) range.push(startBlockId);
    if (endIndex !== -1 && startBlockId !== endBlockId) range.push(endBlockId);
    // If neither is found, or they are the same and not found, an empty array is fine.
    return validateSelectionHierarchy(Array.from(new Set(range)), repo); // Ensure uniqueness if start === end and one is found
  }

  const [minIndex, maxIndex] = [Math.min(startIndex, endIndex), Math.max(startIndex, endIndex)];
  const rangeIds = orderedVisibleBlockIds.slice(minIndex, maxIndex + 1);

  return validateSelectionHierarchy(rangeIds, repo);
}

/**
 * Validates a set of block IDs according to hierarchical selection rules:
 * - When a block is selected, none of its descendants can be selected
 * - When a block is selected, none of its ancestors can be selected
 * @param selectedIds Array of block IDs to validate
 * @param repo Repository instance to find blocks
 * @returns Promise that resolves to an array of valid block IDs
 */
export async function validateSelectionHierarchy(
  selectedIds: string[],
  repo: Repo
): Promise<string[]> {
  const validatedIds = new Set<string>();

  // Process blocks in order - this ensures that if we have both a parent and child,
  // the first one in the list takes precedence
  for (const id of selectedIds) {
    const block = repo.find(id);
    let isValid = true;

    // Check if this block is a descendant of any already-validated blocks
    for (const validId of validatedIds) {
      const validBlock = repo.find(validId);
      if (await block.isDescendantOf(validBlock)) {
        isValid = false;
        break;
      }
      // Also check the reverse - if any validated block is a descendant of this one
      if (await validBlock.isDescendantOf(block)) {
        validatedIds.delete(validId);
      }
    }

    if (isValid) {
      validatedIds.add(id);
    }
  }

  return Array.from(validatedIds);
}

/**
 * Extends selection to include blocks in range between current anchor and target block.
 * Handles the full selection state management including:
 * 1. Gets the current selection state and focused block ID from uiStateBlock
 * 2. Determines the anchor block (either from current state or focused block)
 * 3. Gets the ordered block IDs and computes the range
 * 4. Updates the selection state with the new range
 * 
 * @param targetBlockId The ID of the target block (end of selection)
 * @param uiStateBlock The UI state block that holds selection state
 * @param repo Repository instance to find blocks
 * @returns Promise that resolves to the selected block IDs
 */
export async function extendSelection(
  targetBlockId: string,
  uiStateBlock: Block,
  repo: Repo,
): Promise<string[]> {
  // Get current selection state, focused block ID and top level block ID
  const [currentState, focusedBlockId, topLevelBlockId] = await Promise.all([
    uiStateBlock.getProperty(selectionStateProp),
    uiStateBlock.getProperty(focusedBlockIdProp),
    uiStateBlock.getProperty(topLevelBlockIdProp),
  ]);

  if (!topLevelBlockId?.value || !currentState?.value) return [];

  // Determine anchor block - either from current state or use the focused block
  const currentAnchor = currentState.value.anchorBlockId || focusedBlockId?.value;
  if (!currentAnchor) return [];

  // Get ordered IDs and compute range
  const orderedIds = await getAllVisibleBlockIdsInOrder(repo.find(topLevelBlockId.value));
  const rangeIds = await getBlocksInRange(currentAnchor, targetBlockId, orderedIds, repo);

  // Update selection state
  uiStateBlock.setProperty({
    ...selectionStateProp,
    value: {
      selectedBlockIds: rangeIds,
      anchorBlockId: currentAnchor,
    },
  });

  // Update focused block to target
  uiStateBlock.setProperty({
    ...focusedBlockIdProp,
    value: targetBlockId,
  });

  return rangeIds;
}
