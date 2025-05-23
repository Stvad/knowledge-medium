import { Block } from '../data/block';
import { BlockData } from '../data/block';
import { ClipboardData } from '../types';
import { Repo } from '../data/repo'; // Added import for Repo

// Internal recursive helper function
async function fetchAllDescendantDataRecursively(
  block: Block,
  repo: Repo, // repo is passed for consistency, though block.children() might already use block.repo
): Promise<{ allBlocks: BlockData[]; allMarkdown: string[] }> {
  const currentBlockData = await block.data();
  if (!currentBlockData) {
    return { allBlocks: [], allMarkdown: [] };
  }

  let allBlocks: BlockData[] = [currentBlockData];
  let allMarkdown: string[] = [currentBlockData.content];

  // The block.children() method uses the repo instance stored within the block object itself.
  const children = await block.children(); 

  for (const childBlock of children) {
    const result = await fetchAllDescendantDataRecursively(childBlock, repo);
    allBlocks = allBlocks.concat(result.allBlocks);
    allMarkdown = allMarkdown.concat(result.allMarkdown);
  }

  return { allBlocks, allMarkdown };
}

export async function serializeBlockForClipboard(block: Block, repo: Repo): Promise<ClipboardData> {
  const blockData = await block.data(); // Initial check for the root block being copied

  if (!blockData) {
    throw new Error(`Failed to retrieve data for block with id ${block.id}`);
  }

  const { allBlocks, allMarkdown } = await fetchAllDescendantDataRecursively(block, repo);

  if (allBlocks.length === 0) {
    // This case should ideally not be reached if the initial block.data() succeeded
    // and fetchAllDescendantDataRecursively always includes the starting block.
    // However, as a safeguard:
    throw new Error(`No block data could be serialized for block with id ${block.id}, even after recursive fetch.`);
  }
  
  const combinedMarkdown = allMarkdown.join('\n\n');

  return {
    markdown: combinedMarkdown,
    blocks: allBlocks,
  };
}
