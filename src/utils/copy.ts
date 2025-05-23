import { Block } from '../data/block';
import { BlockData } from '../data/block';
import { ClipboardData } from '../types';
import { Repo } from '../data/repo';

// Internal recursive helper function
async function fetchAllDescendantDataRecursively(
  block: Block,
  repo: Repo,
  currentDepth: number, // New parameter for current depth
): Promise<{ allBlocks: BlockData[]; allMarkdown: string[] }> {
  const currentBlockData = await block.data();
  if (!currentBlockData) {
    return { allBlocks: [], allMarkdown: [] };
  }

  let currentContent = currentBlockData.content;
  // Add indentation based on depth.
  // The root block (currentDepth === 0) of the copy operation will not get leading spaces here.
  const indentation = currentDepth > 0 ? '  '.repeat(currentDepth) : '';
  const indentedContent = indentation + currentContent;

  const allBlocks: BlockData[] = [currentBlockData];
  const allMarkdown: string[] = [indentedContent]; // Store the (potentially) indented content

  const children = await block.children(); // block.children() uses block.repo internally

  for (const childBlock of children) {
    // Make recursive call, incrementing depth for children
    const childResult = await fetchAllDescendantDataRecursively(childBlock, repo, currentDepth + 1);
    allBlocks.push(...childResult.allBlocks);
    allMarkdown.push(...childResult.allMarkdown); // Child markdown is already correctly indented
  }

  return { allBlocks, allMarkdown };
}

export async function serializeBlockForClipboard(block: Block, repo: Repo): Promise<ClipboardData> {
  const initialBlockData = await block.data(); // Check for the root block being copied

  if (!initialBlockData) {
    throw new Error(`Failed to retrieve data for block with id ${block.id}`);
  }

  // Initial call to the recursive helper with depth 0
  const { allBlocks, allMarkdown } = await fetchAllDescendantDataRecursively(block, repo, 0);

  if (allBlocks.length === 0) {
    // This case should ideally not be reached if initialBlockData succeeded.
    throw new Error(`No block data could be serialized for block with id ${block.id}, even after recursive fetch.`);
  }
  
  // Join all markdown lines (which are now individually indented) with a single newline.
  const combinedMarkdown = allMarkdown.join('\n');

  return {
    markdown: combinedMarkdown,
    blocks: allBlocks,
  };
}
