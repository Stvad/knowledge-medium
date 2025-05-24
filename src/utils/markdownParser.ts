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
      const isActiveContextAHeader = contextHeaderHashCount > 0; // Check if current context is from a true header

      if (isActiveContextAHeader && rawLevel > contextHeaderRawIndent) { 
        // PATH A: Current line is an indented child of an ACTIVE HEADER context (H).
        // Example: H -> NH1 (this line)
        contentToStore = originalLineContent; 
        calculatedLevel = contextHeaderCalculatedLevel + 1;
        // NH1 (this line), being a non-header, neutralizes H's context for subsequent lines.
        // This ensures that children of NH1, or siblings of NH1 that are also children of H (like NH2),
        // will perceive the context as non-header, leading to cleaned content for them if they are non-headers.
        contextHeaderHashCount = 0; // Neutralize header context.
      } else {
        // PATH B: Current line (e.g., NH2 or GCA) is:
        // 1. Not a header AND has no active context (e.g. context fully reset by prior NH2).
        // 2. Not a header AND has an active context, but it's now non-header (isActiveContextAHeader was false, e.g. NH1 set hashCount to 0).
        // 3. Not a header AND has/had an active HEADER context, but this line is NOT an indented child of it.
        
        // If there was an active context (contextHeaderCalculatedLevel !== -1)
        // AND this line is NOT taking Path A (already checked by being in this else block),
        // then this line breaks any previous context chain. Reset context fully.
        // This handles cases like:
        // H -> NH1 (Path A, neutralizes hashCount)
        // H -> NH2 (sibling, Path B because hashCount is 0. isActiveContextAHeader is false. This condition then resets full context)
        if (contextHeaderCalculatedLevel !== -1) { // If any context level was active
             // No need to check !(isActiveContextAHeader && rawLevel > contextHeaderRawIndent) again,
             // as that's the condition for the 'else' branch.
            contextHeaderCalculatedLevel = -1; 
            contextHeaderHashCount = 0; // Ensure hashCount is 0 after full reset.
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
    // This logic correctly assigns parents based on the calculated levels.
    // If levels are accurate, parentId should be accurate.
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
