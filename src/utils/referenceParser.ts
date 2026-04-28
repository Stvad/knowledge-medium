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

export interface ParsedBlockRef {
  blockId: string;
  startIndex: number;
  endIndex: number;
  embed: boolean;  // true for !((id)), false for plain ((id))
}

// UUIDv4 shape — anchors what counts as a block-ref id. We deliberately keep
// this strict so accidental double-parens in prose (e.g. "((not an id))")
// don't get treated as references.
const UUID_RE_SOURCE = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}'
const BLOCK_REF_RE = new RegExp(`\\(\\((${UUID_RE_SOURCE})\\)\\)`, 'gi')
const BLOCK_EMBED_RE = new RegExp(`!\\(\\((${UUID_RE_SOURCE})\\)\\)`, 'gi')

export const isBlockRefId = (s: string) => new RegExp(`^${UUID_RE_SOURCE}$`, 'i').test(s)

/**
 * Parse [[alias]] patterns from text content using remark
 * @param content The text content to parse
 * @returns Array of found references with their positions
 */
export function parseReferences(content: string): ParsedReference[] {
  const references: ParsedReference[] = []
  const stack: number[] = [] // Stack to track opening bracket positions
  let i = 0

  while (i < content.length - 1) {
    if (content.slice(i, i + 2) === '[[') {
      stack.push(i)
      i += 2
    } else if (content.slice(i, i + 2) === ']]') {
      if (stack.length > 0) {
        const startPos = stack.pop()!
        const alias = content.slice(startPos + 2, i).trim()
        if (alias) {
          references.push({
            alias,
            startIndex: startPos,
            endIndex: i + 2,
          })
        }
      }
      i += 2
    } else {
      i++
    }
  }

  // Sort references by start position
  return references.sort((a, b) => a.startIndex - b.startIndex)
}

/**
 * Parse references using remark for markdown-aware extraction
 * This version respects markdown structure (ignores code blocks, etc.)
 */
export function parseReferencesMarkdownAware(content: string): ParsedReference[] {
  const references: ParsedReference[] = []

  try {
    const tree = unified()
      .use(remarkParse)
      .parse(content)

    visit(tree, 'text', (node: Text, _index, parent) => {
      // Skip if we're inside a code block or inline code
      if (['code', 'inlineCode'].includes(parent?.type as string)) return

      const text = node.value
      const regex = /\[\[([^\]]+)\]\]/g
      let match

      while ((match = regex.exec(text)) !== null) {
        const alias = match[1].trim()
        if (alias) {
          // Note: position calculation would need more work for exact positions
          // For now, we'll use the simpler approach
          references.push({
            alias,
            startIndex: match.index,
            endIndex: match.index + match[0].length,
          })
        }
      }
    })
  } catch (error) {
    console.warn('Error parsing references:', error)
    // Fallback to regex parsing if remark fails
    return parseReferences(content)
  }

  return references
}

/**
 * Extract just the alias strings from content
 * @param content The text content to parse
 * @returns Array of unique alias strings found
 */
export function extractAliases(content: string): string[] {
  const references = parseReferences(content)
  const uniqueAliases = new Set(references.map(ref => ref.alias))
  return Array.from(uniqueAliases)
}

/**
 * Check if content contains any references
 * @param content The text content to check
 * @returns True if content contains [[alias]] patterns
 */
export function hasReferences(content: string): boolean {
  return /\[\[([^\]]+)\]\]/.test(content)
}

/**
 * Parse `((uuid))` block-refs and `{{embed: ((uuid))}}` block-embeds out of
 * text. Embeds are matched first so the outer `{{embed: ...}}` isn't double-
 * counted as a bare ref.
 */
export function parseBlockRefs(content: string): ParsedBlockRef[] {
  const found: ParsedBlockRef[] = []
  const consumed: Array<[number, number]> = []

  BLOCK_EMBED_RE.lastIndex = 0
  let match: RegExpExecArray | null
  while ((match = BLOCK_EMBED_RE.exec(content)) !== null) {
    found.push({
      blockId: match[1].toLowerCase(),
      startIndex: match.index,
      endIndex: match.index + match[0].length,
      embed: true,
    })
    consumed.push([match.index, match.index + match[0].length])
  }

  BLOCK_REF_RE.lastIndex = 0
  while ((match = BLOCK_REF_RE.exec(content)) !== null) {
    const start = match.index
    const end = start + match[0].length
    if (consumed.some(([s, e]) => start >= s && end <= e)) continue
    found.push({
      blockId: match[1].toLowerCase(),
      startIndex: start,
      endIndex: end,
      embed: false,
    })
  }

  return found.sort((a, b) => a.startIndex - b.startIndex)
}

export function extractBlockRefIds(content: string): string[] {
  return Array.from(new Set(parseBlockRefs(content).map(r => r.blockId)))
}
