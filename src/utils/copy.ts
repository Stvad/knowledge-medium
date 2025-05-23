import { Block } from '../data/block';
import { BlockData } from '../data/block'; // Corrected: BlockData is also from ../data/block
import { ClipboardData } from '../types';

export async function serializeBlockForClipboard(block: Block): Promise<ClipboardData> {
  const blockData = await block.data();

  if (!blockData) {
    // This case should ideally be handled based on how the application expects to manage errors.
    // For now, throwing an error as per initial thoughts, though returning a specific
    // ClipboardData structure indicating an error or empty state might be preferable
    // depending on broader error handling strategies.
    throw new Error(`Failed to retrieve data for block with id ${block.id}`);
  }

  // The task specifies to use blockData.content for markdown and [blockData] for blocks.
  // This implies a single block is being serialized here.
  // If child blocks or a more complex structure were needed, this would be more involved.
  return {
    markdown: blockData.content,
    blocks: [blockData],
  };
}
