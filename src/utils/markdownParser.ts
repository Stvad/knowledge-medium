import { BlockData } from '@/types'
import { v4 as uuidv4 } from 'uuid'

interface ParsedBlock {
  content: string;
  level: number;
}

export function parseMarkdownToBlocks(text: string): Partial<BlockData>[] {
  const lines = text.split('\n');
  const parsedBlocks: ParsedBlock[] = [];
  let baseIndent = -1;  // Will be set by first non-empty line

  // First pass: parse lines into blocks with levels
  for (const line of lines) {
    if (!line.trim()) continue;

    const rawLevel = getIndentationLevel(line);

    // Set base indentation from first line
    if (baseIndent === -1) {
      baseIndent = rawLevel;
    }

    // Adjust level relative to base indentation
    const adjustedLevel = Math.max(0, rawLevel - baseIndent);

    parsedBlocks.push({
      content: cleanLine(line),
      level: adjustedLevel,
    });
  }

  // Second pass: convert to BlockData[] with proper parent/child relationships
  const blocks: Partial<BlockData>[] = [];

  // Stack to keep track of parent blocks at each level
  const parentStack: Partial<BlockData>[] = [];

  for (const parsed of parsedBlocks) {
    const blockData: Partial<BlockData> = {
      childIds: [],
      id: uuidv4(),
      content: parsed.content,
    };

    // Pop stack until we find the parent at the right level
    while (parentStack.length > parsed.level) {
      parentStack.pop();
    }

    // Set parent relationship
    if (parentStack.length > 0) {
      // Find the correct parent in the stack, skipping empty slots
      let parentIndex = parsed.level - 1;
      while (parentIndex >= 0 && !parentStack[parentIndex]) {
        parentIndex--;
      }
      if (parentIndex >= 0) {
        const parent = parentStack[parentIndex];
        blockData.parentId = parent.id;
        parent.childIds?.push(blockData.id!);
      }
    }

    parentStack[parsed.level] = blockData;
    blocks.push(blockData);
  }

  return blocks;
}

function getIndentationLevel(line: string): number {
  // Base indentation on leading spaces/tabs
  const indentMatch = line.match(/^[\s\t]*/)?.[0] || '';
   // 2 spaces = 1 level
  return Math.floor(indentMatch.length / 2);
}

function cleanLine(line: string): string {
  // Remove list markers while preserving content
  return line.replace(/^(\s*[-*+]|\s*\d+\.)\s+/, '').trim();
}
