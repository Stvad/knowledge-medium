import { BlockData } from '@/types'
import { v4 as uuidv4 } from 'uuid'

interface ParsedBlock {
  content: string;
  level: number;
}

export function parseMarkdownToBlocks(text: string): Partial<BlockData>[] {
  const lines = text.split('\n');
  const parsedBlocks: ParsedBlock[] = [];
  let baseIndent = -1;

  // Context variables for the current header scope
  let contextHeaderCalculatedLevel = -1;
  let contextHeaderHashCount = 0;
  let contextHeaderRawIndent = -1;

  // First pass: parse lines into blocks with levels
  for (const line of lines) {
    const originalLineContent = line;
    const trimmedLine = line.trim();

    if (!trimmedLine) {
      // Empty line resets any active header context for subsequent lines
      contextHeaderCalculatedLevel = -1;
      contextHeaderHashCount = 0;
      contextHeaderRawIndent = -1;
      continue;
    }

    const rawLevel = getIndentationLevel(line);
    let contentToStore: string;
    let calculatedLevel: number;

    const isCurrentLineHeader = trimmedLine.startsWith('#');

    if (isCurrentLineHeader) {
      contentToStore = trimmedLine; // Preserve # characters
      const newHeaderHashCount = trimmedLine.match(/^#+/)[0].length;

      if (baseIndent === -1) {
        baseIndent = rawLevel;
      }

      // Determine calculatedLevel for THIS header block
      if (contextHeaderCalculatedLevel !== -1 && // Is there an active header context?
          newHeaderHashCount > contextHeaderHashCount &&
          rawLevel >= contextHeaderRawIndent) { // Standard sub-header (e.g., # H1 then ## H2 at same/greater indent)
        calculatedLevel = contextHeaderCalculatedLevel + 1;
      } else {
        // Default: No prior context qualifying this as a direct sub-header,
        // or it's a peer/outdented header relative to the active context.
        // Calculate level based on its own indentation.
        // (This covers cases like ##H2 then #H1, or #H1 then another #H1, or first header)
        calculatedLevel = Math.max(0, rawLevel - baseIndent);
      }
      
      // This header now establishes the new context for subsequent lines
      contextHeaderCalculatedLevel = calculatedLevel;
      contextHeaderHashCount = newHeaderHashCount;
      contextHeaderRawIndent = rawLevel;

    } else { // Current line is NOT a header
      // It might be a child of an existing header context, or a regular line.
      if (contextHeaderCalculatedLevel !== -1 && // Check if a header context actually exists
          rawLevel > contextHeaderRawIndent) { // Must be more indented than the context header line
        // This non-header line is a child of the active header context
        contentToStore = originalLineContent; // Preserve original spacing, list markers, etc.
        calculatedLevel = contextHeaderCalculatedLevel + 1;
      } else {
        // Not a header, and not an indented child of an active header context.
        // It's a regular line.
        // This line effectively BREAKS the previous header's context for subsequent lines.
        if (contextHeaderCalculatedLevel !== -1) { // If there was an active context
          contextHeaderCalculatedLevel = -1; // Reset context
          contextHeaderHashCount = 0;
          contextHeaderRawIndent = -1;
        }
        
        if (baseIndent === -1) {
          baseIndent = rawLevel;
        }
        calculatedLevel = Math.max(0, rawLevel - baseIndent);
        // For regular lines, clean them by removing list markers from the trimmed line.
        contentToStore = trimmedLine.replace(/^([-*+]|\d+\.)\s+/, '');
      }
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
