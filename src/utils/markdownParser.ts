import { BlockData } from '@/types'
import { v4 as uuidv4 } from 'uuid'

interface ParsedBlock {
  content: string;
  level: number;
}

export function parseMarkdownToBlocks(text: string): Partial<BlockData>[] {
  const lines = text.split('\n');
  const parsedBlocks: { content: string; level: number; id: string }[] = [];
  let baseIndent = -1;

  interface ContextNode {
    level: number;
    rawIndent: number;
    id: string;
    type: string; // e.g., 'root', 'h1', 'h2', 'ul-item', 'ol-item', 'text'
  }

  const contextStack: ContextNode[] = [{ level: -1, rawIndent: -1, id: 'ROOT', type: 'root' }];

  function determineLineTypeAndContent(trimmedLine: string): { type: string; content: string } {
    if (trimmedLine.startsWith('#')) {
      const match = trimmedLine.match(/^(#+)\s*(.*)/);
      if (match) {
        const level = match[1].length;
        return { type: `h${level}`, content: trimmedLine }; // Keep '#'
      }
    }
    const ulMatch = trimmedLine.match(/^([-*+])\s+(.*)/);
    if (ulMatch) {
      return { type: 'ul-item', content: ulMatch[2] }; // Strip marker
    }
    const olMatch = trimmedLine.match(/^(\d+\.)\s+(.*)/);
    if (olMatch) {
      return { type: 'ol-item', content: trimmedLine }; // Keep number e.g. "1. item"
    }
    return { type: 'text', content: trimmedLine };
  }

  // First pass: parse lines into blocks with levels
  for (const line of lines) {
    const originalLineContent = line;
    const trimmedLine = line.trim();

    if (!trimmedLine) {
      continue; // Skip empty lines
    }

    const currentLineRawIndent = getIndentationLevel(originalLineContent);
    const { type: currentLineType, content: processedContent } = determineLineTypeAndContent(trimmedLine);

    if (baseIndent === -1) {
      baseIndent = currentLineRawIndent;
    }

    // Implement/Refine Nuanced Context Stack Popping Logic
    while (contextStack.length > 1) { // contextStack[0] is root, never pop it
        const parentCtx = contextStack[contextStack.length - 1];
        const currentHeaderNum = currentLineType.startsWith('h') ? parseInt(currentLineType.substring(1)) : 0;
        const parentHeaderNum = parentCtx.type.startsWith('h') ? parseInt(parentCtx.type.substring(1)) : 0;

        if (currentLineRawIndent > parentCtx.rawIndent) { // Case A: Strictly indented, current line is a child.
            break; 
        } else if (currentLineRawIndent === parentCtx.rawIndent) { // Case B: Same indent level.
            if (parentCtx.type.startsWith('h') && !currentLineType.startsWith('h')) { // B1: Text/list after header at same indent IS CHILD of header.
                break;
            } else if (parentCtx.type.startsWith('h') && currentLineType.startsWith('h')) { // B2: Header after header at same indent.
                if (currentHeaderNum > parentHeaderNum) { // Deeper header (e.g., H2 after H1) IS CHILD.
                    break;
                } else { // Same or shallower header (e.g., H1 after H1, H1 after H2) is SIBLING (pops parent).
                    contextStack.pop();
                }
            } else if ((parentCtx.type === 'ul-item' && currentLineType === 'ul-item') ||
                       (parentCtx.type === 'ol-item' && currentLineType === 'ol-item')) { // B3: List item sibling of same type.
                 contextStack.pop(); // Pop previous item; current item becomes child of previous item's parent.
                                     // Loop will re-evaluate against new stack top.
            } else { // B4: Other same-indent cases (e.g., text after text, header after list/text). Treat as SIBLING (pops parent).
                contextStack.pop();
            }
        } else { // Case C: currentLineRawIndent < parentCtx.rawIndent (outdented). Pop parent.
            contextStack.pop();
        }
    }
    
    // Level Calculation
    const activeParentContext = contextStack[contextStack.length - 1];
    let calculatedLevel = activeParentContext.level + 1;

    // Content is already processed by determineLineTypeAndContent

    const newBlockId = uuidv4();
    parsedBlocks.push({ content: processedContent, level: calculatedLevel, id: newBlockId });

    // Context Stack Pushing Logic: Push context for ALL processed lines.
    contextStack.push({
        level: calculatedLevel,
        rawIndent: currentLineRawIndent,
        id: newBlockId,
        type: currentLineType
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
      // numChildren and isRoot will be set by the test helper or consuming code if needed.
      // The parser's primary job is content, parentId, and childIds based on level.
    };

    // Pop stack until we find the parent at the right level.
    // The stack should contain the direct parent at parentStack[parsed.level - 1]
    // if parsed.level > 0.
    while (parentStack.length > parsed.level) {
      parentStack.pop();
    }
    
    // Set parent relationship
    if (parsed.level > 0 && parentStack.length === parsed.level && parentStack[parsed.level - 1]) {
      const parent = parentStack[parsed.level - 1];
      if (parent) { // Ensure parent exists
        blockData.parentId = parent.id;
        parent.childIds = parent.childIds || []; // Initialize if undefined
        parent.childIds.push(blockData.id!);
      }
    } else if (parsed.level > 0) {
        // This case implies a jump in level without a direct parent in the stack at the expected position.
        // This can happen if levels are not contiguous or parsing logic leads to unexpected level calculations.
        // For robustness, one might search backwards in the stack for the closest valid parent.
        // However, with the current level calculation logic, parentStack[parsed.level - 1] should be the target.
        // If it's not there, it might indicate an issue with level calculation or stack management.
        // For now, we stick to the direct expectation.
    }


    // Add current block to the stack at its level.
    // If parentStack is shorter than parsed.level, fill with undefined/null up to parsed.level -1
    while (parentStack.length < parsed.level) {
        parentStack.push(undefined as any); // Should ideally be null or a specific placeholder
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

// cleanLine is not used in the provided code, can be removed if not needed elsewhere.
// function cleanLine(line: string): string {
//   // Only trim the line initially. Specific cleaning will be done in the parsing logic.
//   return line.trim();
// }
