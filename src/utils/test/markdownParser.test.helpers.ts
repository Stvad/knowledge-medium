import { expect } from 'vitest';
import { BlockData } from '@/types'; // Assuming BlockData is in @/types

type BlockCriteria = string | { content?: string; id?: string };

/**
 * Finds a block within an array of blocks based on specified criteria.
 *
 * @param blocks - The array of Partial<BlockData> to search within.
 * @param criteria - If a string, searches by content. If an object, matches blocks with all specified properties.
 * @param options - Optional settings.
 * @param options.expectUnique - If true (default), throws an error if zero or more than one block matches.
 *                               If false, returns the first match or undefined if none.
 * @returns The found block (Partial<BlockData>) or undefined (if options.expectUnique is false and no match).
 * @throws Error if no block is found or multiple blocks are found when options.expectUnique is true.
 */
export function findBlock(
  blocks: Partial<BlockData>[],
  criteria: BlockCriteria,
  options: { expectUnique?: boolean } = { expectUnique: true }
): Partial<BlockData> | undefined {
  let foundBlocks: Partial<BlockData>[];

  if (typeof criteria === 'string') {
    foundBlocks = blocks.filter(block => block.content === criteria);
  } else {
    foundBlocks = blocks.filter(block => {
      let matches = true;
      if (criteria.content !== undefined && block.content !== criteria.content) {
        matches = false;
      }
      if (criteria.id !== undefined && block.id !== criteria.id) {
        matches = false;
      }
      return matches;
    });
  }

  if (options.expectUnique) {
    if (foundBlocks.length === 0) {
      throw new Error(`Test Helper Error: No block found matching criteria: ${JSON.stringify(criteria)}`);
    }
    if (foundBlocks.length > 1) {
      throw new Error(`Test Helper Error: Multiple blocks found matching criteria: ${JSON.stringify(criteria)}`);
    }
    return foundBlocks[0];
  } else {
    return foundBlocks.length > 0 ? foundBlocks[0] : undefined;
  }
}

/**
 * Asserts various properties of a given block.
 *
 * @param block - The block to assert properties on.
 * @param expected - An object containing expected properties.
 * @param expected.content - Expected content of the block.
 * @param expected.parentId - Expected parentId (or null for root).
 * @param expected.numChildren - Expected number of children.
 * @param expected.hasChildIds - Array of expected child IDs.
 * @param expected.hasNoChildIds - If true, asserts childIds is empty or undefined.
 * @param expected.isRoot - If true, asserts parentId is undefined or null.
 */
export function assertBlockProperties(
  block: Partial<BlockData> | undefined,
  expected: {
    content?: string;
    parentId?: string | null; // null means expect undefined or null parentId
    numChildren?: number;
    hasChildIds?: string[];
    hasNoChildIds?: boolean;
    isRoot?: boolean;
  }
): void {
  expect(block, `Block should be defined. Searched with criteria that led to this block.`).toBeDefined();
  // Use a type assertion to tell TypeScript that block is defined from this point onwards.
  const currentBlock = block!;

  if (expected.content !== undefined) {
    expect(currentBlock.content, `Block content mismatch for block ID ${currentBlock.id}`).toBe(expected.content);
  }

  if (expected.parentId !== undefined) {
    if (expected.parentId === null) {
      expect(currentBlock.parentId, `Expected block ID ${currentBlock.id} to be a root block (parentId undefined or null).`).toBeFalsy();
    } else {
      expect(currentBlock.parentId, `Block parentId mismatch for block ID ${currentBlock.id}`).toBe(expected.parentId);
    }
  }

  if (expected.isRoot === true) {
    expect(currentBlock.parentId, `Expected block ID ${currentBlock.id} to be a root block (parentId undefined or null).`).toBeFalsy();
  }
  
  if (expected.numChildren !== undefined) {
    expect(currentBlock.childIds?.length ?? 0, `Block numChildren mismatch for block ID ${currentBlock.id}`).toBe(expected.numChildren);
  }

  if (expected.hasChildIds?.length) {
    expect(currentBlock.childIds, `Block childIds missing for block ID ${currentBlock.id}`).toBeDefined();
    expected.hasChildIds.forEach(expectedChildId => {
      expect(currentBlock.childIds, `Block ID ${currentBlock.id} missing childId ${expectedChildId}`).toContain(expectedChildId);
    });
  }
  
  if (expected.hasNoChildIds === true) {
    expect(currentBlock.childIds === undefined || currentBlock.childIds?.length === 0, `Expected block ID ${currentBlock.id} to have no children.`).toBe(true);
  }
}

/**
 * Asserts a parent-child relationship between two blocks.
 *
 * @param allBlocks - The array of all blocks, used for finding parent and child.
 * @param parentCriteria - Criteria to find the parent block (string for content, or object for properties).
 * @param childCriteria - Criteria to find the child block.
 */
export function assertParentChild(
  allBlocks: Partial<BlockData>[],
  parentCriteria: BlockCriteria,
  childCriteria: BlockCriteria
): void {
  const parentBlock = findBlock(allBlocks, parentCriteria, { expectUnique: true });
  const childBlock = findBlock(allBlocks, childCriteria, { expectUnique: true });

  // Ensure blocks were found (findBlock with expectUnique: true throws if not)
  // but as a safeguard for type checking if expectUnique was false (not the case here).
  if (!parentBlock || !childBlock) { 
    // This case should ideally be prevented by findBlock's error throwing
    throw new Error('Parent or child block not found for relationship assertion.');
  }
  
  expect(childBlock.parentId, `Child block (content: "${childBlock.content}") parentId should match parent block (content: "${parentBlock.content}") id.`).toBe(parentBlock.id);
  expect(parentBlock.childIds, `Parent block (content: "${parentBlock.content}") childIds should include child block (content: "${childBlock.content}") id.`).toContain(childBlock.id!);
}
