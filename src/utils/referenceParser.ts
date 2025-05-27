/**
 * Reference parser for [[alias]] syntax in block content
 * Uses remark-based parsing for consistency with markdown rendering
 */

import { unified } from 'unified'
import remarkParse from 'remark-parse'
import { visit } from 'unist-util-visit'
import type { Text } from 'mdast'

export interface ParsedReference {
  alias: string;
  startIndex: number;
  endIndex: number;
}

/**
 * Parse [[alias]] patterns from text content using remark
 * @param content The text content to parse
 * @returns Array of found references with their positions
 */
export function parseReferences(content: string): ParsedReference[] {
  const references: ParsedReference[] = [];
  
  // Use regex as fallback for simple cases and position tracking
  const regex = /\[\[([^\]]+)\]\]/g;
  let match;

  while ((match = regex.exec(content)) !== null) {
    const alias = match[1].trim();
    if (alias) {
      references.push({
        alias,
        startIndex: match.index,
        endIndex: match.index + match[0].length,
      });
    }
  }

  return references;
}

/**
 * Parse references using remark for markdown-aware extraction
 * This version respects markdown structure (ignores code blocks, etc.)
 */
export function parseReferencesMarkdownAware(content: string): ParsedReference[] {
  const references: ParsedReference[] = [];
  
  try {
    const tree = unified()
      .use(remarkParse)
      .parse(content);

    visit(tree, 'text', (node: Text, _index, parent) => {
      // Skip if we're inside a code block or inline code
      if (['code', 'inlineCode'].includes(parent?.type as string)) return

      const text = node.value;
      const regex = /\[\[([^\]]+)\]\]/g;
      let match;

      while ((match = regex.exec(text)) !== null) {
        const alias = match[1].trim();
        if (alias) {
          // Note: position calculation would need more work for exact positions
          // For now, we'll use the simpler approach
          references.push({
            alias,
            startIndex: match.index,
            endIndex: match.index + match[0].length,
          });
        }
      }
    });
  } catch (error) {
    console.warn('Error parsing references:', error);
    // Fallback to regex parsing if remark fails
    return parseReferences(content);
  }

  return references;
}

/**
 * Extract just the alias strings from content
 * @param content The text content to parse
 * @returns Array of unique alias strings found
 */
export function extractAliases(content: string): string[] {
  const references = parseReferences(content);
  const uniqueAliases = new Set(references.map(ref => ref.alias));
  return Array.from(uniqueAliases);
}

/**
 * Check if content contains any references
 * @param content The text content to check
 * @returns True if content contains [[alias]] patterns
 */
export function hasReferences(content: string): boolean {
  return /\[\[([^\]]+)\]\]/.test(content);
}
