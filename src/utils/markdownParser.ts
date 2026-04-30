import { v4 as uuidv4 } from 'uuid'

/** Lightweight intermediate shape produced by the markdown parser.
 *  Holds only the fields the importer actually needs — id, content,
 *  parentId, orderKey. Workspace + the rest of BlockData come from
 *  the importer's context. */
export interface ParsedBlock {
  id: string
  parentId?: string
  orderKey: string
  content: string
}

export function parseMarkdownToBlocks(text: string): ParsedBlock[] {
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
    const calculatedLevel = activeParentContext.level + 1;

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

  // Second pass: convert to ParsedBlock[] with parentId + orderKey.
  // The new tree shape stores parent_id+order_key as the source of
  // truth — no childIds array. Each parent tracks how many children
  // it's seen so we can synth a deterministic order key per sibling.
  const blocks: ParsedBlock[] = []
  const parentStack: Array<{id: string; childCount: number} | undefined> = []

  for (const parsed of parsedBlocks) {
    const id = uuidv4()

    // Pop stack until we find the parent at the right level.
    while (parentStack.length > parsed.level) {
      parentStack.pop()
    }

    let parentId: string | undefined
    let orderKey = 'a0'  // root-level siblings: caller decides
    if (parsed.level > 0 && parentStack.length === parsed.level && parentStack[parsed.level - 1]) {
      const parent = parentStack[parsed.level - 1]!
      parentId = parent.id
      orderKey = `a${parent.childCount}`
      parent.childCount++
    }

    while (parentStack.length < parsed.level) {
      parentStack.push(undefined)
    }
    parentStack[parsed.level] = {id, childCount: 0}
    blocks.push({id, parentId, orderKey, content: parsed.content})
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
