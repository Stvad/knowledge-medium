import { BlockData } from '@/types'
import { v4 as uuidv4 } from 'uuid'

interface ParsedBlock {
  content: string;
  level: number;
}

export function parseMarkdownToBlocks(text: string): BlockData[] {
  const lines = text.split('\n');
  const parsedBlocks: ParsedBlock[] = [];
  let previousLevel = 0;
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
    // Ensure level only increases by 1 from previous level
    const level = Math.min(previousLevel + 1, adjustedLevel);

    parsedBlocks.push({
      content: cleanLine(line),
      level,
    });
    
    previousLevel = level;
  }
  
  // Second pass: convert to BlockData[] with proper parent/child relationships
  const blocks: BlockData[] = [];
  const defaults = {
    properties: {},
    childIds: [],
    createTime: Date.now(),
    updateTime: Date.now(),
  };
  
  // Stack to keep track of parent blocks at each level
  const parentStack: BlockData[] = [];
  
  for (const parsed of parsedBlocks) {
    const blockData: BlockData = {
      ...defaults,
      id: uuidv4(),
      content: parsed.content,
      childIds: [],
    };
    
    // Pop stack until we find the parent at the right level
    while (parentStack.length > parsed.level) {
      parentStack.pop();
    }
    
    // Set parent relationship
    if (parentStack.length > 0) {
      const parent = parentStack[parentStack.length - 1];
      blockData.parentId = parent.id;
      parent.childIds.push(blockData.id);
    }
    
    parentStack[parsed.level] = blockData;
    blocks.push(blockData);
  }
  
  return blocks;
}

function getIndentationLevel(line: string): number {
  // Base indentation on leading spaces/tabs
  const indentMatch = line.match(/^[\s\t]*/)?.[0] || '';
  let level = Math.floor(indentMatch.length / 2); // 2 spaces = 1 level
  
  // Additional level for list items
  if (line.match(/^\s*[-*+]\s/)) {
    level += 1;
  }
  
  return level;
}

function cleanLine(line: string): string {
  // Remove list markers while preserving content
  return line.replace(/^(\s*[-*+]|\s*\d+\.)\s+/, '').trim();
}
