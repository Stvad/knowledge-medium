import { BlockData } from '@/types'
import { v4 as uuidv4 } from 'uuid'

interface ParsedBlock {
  content: string;
  level: number;
}

export function parseMarkdownToBlocks(text: string): Partial<BlockData>[] {
  const lines = text.split('\n');
  const parsedBlocks: ParsedBlock[] = [];
  let baseIndent = -1; // Will be set by first non-empty line
  let currentHeaderLevel = -1;
  let isInsideHeader = false;

  // First pass: parse lines into blocks with levels
  for (const line of lines) {
    const originalLineContent = line; // Keep for potential use as content for children of headers
    const trimmedLine = line.trim(); // Used for checks and for header content base

    if (!trimmedLine) {
      // Empty line resets header context
      isInsideHeader = false;
      currentHeaderLevel = -1;
      // baseIndent should not reset here.
      continue;
    }

    const rawLevel = getIndentationLevel(line); // Indentation of the current line
    let contentToStore: string;
    let calculatedLevel: number;

    const isHeaderLine = trimmedLine.startsWith('#');

    if (isHeaderLine) {
      isInsideHeader = true;
      contentToStore = trimmedLine.replace(/^#+\s*/, ''); // Cleaned header content
      if (baseIndent === -1) {
        baseIndent = rawLevel; // Set base indent if this is the first content line
      }
      // Header's level is based on its own indentation relative to baseIndent
      currentHeaderLevel = Math.max(0, rawLevel - baseIndent);
      calculatedLevel = currentHeaderLevel;
    } else if (isInsideHeader) {
      // Child of a header
      // Content is the raw line itself to preserve all original spacing and list markers.
      contentToStore = originalLineContent;
      calculatedLevel = currentHeaderLevel + 1; // Level is one deeper than the current header
    } else {
      // Regular line, not a header and not under a header
      // isInsideHeader should be false here. (It would have been reset by an empty line or never set true)
      if (baseIndent === -1) {
        baseIndent = rawLevel; // Set base indent if this is the first content line
      }
      calculatedLevel = Math.max(0, rawLevel - baseIndent);
      // For regular lines, clean them by removing list markers from the trimmed line.
      // (If it's not a list item, this replacement does nothing)
      contentToStore = trimmedLine.replace(/^([-*+]|\d+\.)\s+/, '');
    }

    parsedBlocks.push({
      content: contentToStore,
      level: calculatedLevel,
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
  // Only trim the line initially. Specific cleaning will be done in the parsing logic.
  return line.trim();
}
