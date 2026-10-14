import { fromMarkdown } from 'mdast-util-from-markdown'
import { gfmTableFromMarkdown } from 'mdast-util-gfm-table'
import { gfmTable } from 'micromark-extension-gfm-table'
import { v4 as uuidv4 } from 'uuid'
import { keyAtEnd } from '../data/orderKey.ts'

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

/** A block to create, with the blocks nested under it. The tree-shaped form
 *  of a paste: what {@link outlineFromTokens} builds, and what a paste-decision
 *  override that has already structured its content hands back directly. */
export interface OutlineNode {
  content: string
  children?: readonly OutlineNode[]
}

/** One block-to-be as a front end (markdown lines, clipboard HTML) recognized
 *  it, before nesting. `indent` is only ever compared between tokens, so a
 *  front end may count it in any unit that grows with depth. */
export type OutlineToken =
  | {kind: 'heading'; level: number; indent: number; content: string}
  | {kind: 'list-item'; indent: number; content: string}
  | {kind: 'paragraph'; indent: number; content: string}
  /** Multi-line content kept whole — a fenced code block, a table, a quote. */
  | {kind: 'atomic'; indent: number; content: string}

/** Wrap `content` verbatim as a single root `ParsedBlock` — no markdown
 *  splitting, newlines preserved inside the one block. Used for "paste as
 *  one block" (the block-shell paste when the decision is `single-block`).
 *  The `orderKey` is a placeholder; insertion paths recompute it. */
export const singleParsedBlock = (content: string): ParsedBlock => ({
  id: uuidv4(),
  orderKey: keyAtEnd(),
  content,
})

/** Whether `token` nests under `parent` when both sit at the same indent
 *  (a deeper token always nests, a shallower one never does):
 *   - a heading owns what follows it, up to the next heading of the same or
 *     a shallower level;
 *   - a list nests under the paragraph that introduces it;
 *   - anything else is a sibling. */
const nestsAtSameIndent = (parent: OutlineToken, token: OutlineToken): boolean => {
  if (parent.kind === 'heading') return token.kind !== 'heading' || token.level > parent.level
  return parent.kind === 'paragraph' && token.kind === 'list-item'
}

/** Nest a token stream into an outline. The one place the paste structuring
 *  rules live, shared by every front end so markdown text and clipboard HTML
 *  of the same document come out the same shape. */
export const outlineFromTokens = (tokens: readonly OutlineToken[]): OutlineNode[] => {
  const roots: OutlineNode[] = []
  const open: Array<{token: OutlineToken; children: OutlineNode[]}> = []
  for (const token of tokens) {
    while (open.length > 0) {
      const parent = open[open.length - 1].token
      if (token.indent > parent.indent) break
      if (token.indent === parent.indent && nestsAtSameIndent(parent, token)) break
      open.pop()
    }
    const children: OutlineNode[] = []
    ;(open.at(-1)?.children ?? roots).push({content: token.content, children})
    open.push({token, children})
  }
  return roots
}

/** Flatten an outline into `ParsedBlock`s in document order, minting ids and
 *  per-parent ascending order keys (base62 fractional keys via `keyAtEnd`;
 *  `a${index}` would break lexicographic sort at 11+ siblings). Root keys form
 *  an ordered sequence too — callers overwrite them, but tests and direct
 *  consumers rely on the sort matching document order. Iterative, so a
 *  pathologically deep paste can't overflow the stack. */
export const parsedBlocksFromOutline = (roots: readonly OutlineNode[]): ParsedBlock[] => {
  const blocks: ParsedBlock[] = []
  const pending: Array<{node: OutlineNode; parentId: string | undefined}> =
    roots.map(node => ({node, parentId: undefined})).reverse()
  const lastKeyByParent = new Map<string | undefined, string>()
  while (pending.length > 0) {
    const {node, parentId} = pending.pop()!
    const id = uuidv4()
    const orderKey = keyAtEnd(lastKeyByParent.get(parentId) ?? null)
    lastKeyByParent.set(parentId, orderKey)
    blocks.push({id, parentId, orderKey, content: node.content})
    const children = node.children ?? []
    for (let i = children.length - 1; i >= 0; i--) pending.push({node: children[i], parentId: id})
  }
  return blocks
}

export function parseMarkdownToBlocks(text: string): ParsedBlock[] {
  return parsedBlocksFromOutline(outlineFromTokens(lexMarkdownLines(text)))
}

/** Split markdown/outline text into tokens, one per non-blank line except
 *  for fenced code blocks, tables and quotes, which are consumed whole. */
const lexMarkdownLines = (text: string): OutlineToken[] => {
  const lines = text.split('\n')
  const tokens: OutlineToken[] = []
  let idx = 0
  while (idx < lines.length) {
    const line = lines[idx]
    const trimmed = line.trim()
    if (!trimmed) {
      idx++
      continue
    }
    const indent = getIndentationLevel(line)

    const token = lineToken(trimmed, indent)
    const atomicEnd = fencedCodeEnd(lines, idx) ??
      (token.kind === 'paragraph' ? tableEnd(lines, idx) ?? quoteEnd(lines, idx) : undefined)
    if (atomicEnd !== undefined) {
      // Strip the opening line's indentation from every line so nested
      // content doesn't carry it; the block nests like a plain line at that
      // indent.
      const openingWs = line.match(/^[ \t]*/)?.[0].length ?? 0
      const content = lines.slice(idx, atomicEnd)
        .map(raw => stripLeadingWhitespace(raw, openingWs))
        .join('\n')
        .replace(/[ \t\r\n]+$/, '')
      tokens.push({kind: 'atomic', indent, content})
      idx = atomicEnd
      continue
    }
    tokens.push(token)
    idx++
  }
  return tokens
}

const lineToken = (trimmed: string, indent: number): OutlineToken => {
  // CommonMark's ATX heading: 1-6 '#'s, then a space or the end of the line
  // (`#tag` and `#######` are text). Keep the '#'s: the level renders from
  // the content.
  const heading = /^(#{1,6})(?:[ \t]|$)/.exec(trimmed)
  if (heading) return {kind: 'heading', level: heading[1].length, indent, content: trimmed}
  const bullet = /^[-*+]\s+(.*)/.exec(trimmed)
  if (bullet) return {kind: 'list-item', indent, content: bullet[1]}
  // Keep the number, e.g. "1. item".
  if (/^\d+\.\s+/.test(trimmed)) return {kind: 'list-item', indent, content: trimmed}
  return {kind: 'paragraph', indent, content: trimmed}
}

/** End (exclusive line index) of the fenced code block opening at `start`,
 *  or undefined when that line opens none. Handles ``` and ~~~ fences
 *  (CommonMark): runs through the closing fence or EOF, and never interprets
 *  inner lines as list markers / headers. The closer is a run of the SAME
 *  char, AT LEAST as long as the opener, with nothing else on the line — so a
 *  reply can open with ```` (or ~~~) to wrap content that itself contains
 *  ``` without closing early. */
const fencedCodeEnd = (lines: readonly string[], start: number): number | undefined => {
  const fenceOpen = /^([`~])\1{2,}/.exec(lines[start].trim())
  if (!fenceOpen) return undefined
  const closesFence = new RegExp('^' + fenceOpen[1] + '{' + fenceOpen[0].length + ',}$')
  let end = start + 1
  while (end < lines.length) {
    if (closesFence.test(lines[end++].trim())) break
  }
  return end
}

/** A line that could be a GFM delimiter row — a cheap filter so the parser
 *  only runs on real table candidates, not on every line with a pipe. */
const MAYBE_DELIMITER_ROW = /^[\s|:-]*-[\s|:-]*$/

/** End (exclusive line index) of the GFM table whose header row is at
 *  `start`, or undefined when there is none. The GFM parser the app renders
 *  with decides what is a table, so escapes and code spans match what the
 *  block will show, and a blank line or another block (a bullet, a quote)
 *  ends it. Unlike GFM, a row without a pipe ends it too: GFM's lazy row is,
 *  in pasted notes, the next line of the note (quotes follow the same rule). */
const tableEnd = (lines: readonly string[], start: number): number | undefined => {
  const delimiter = lines[start + 1]?.trim() ?? ''
  if (!lines[start].includes('|') || !delimiter.includes('|') || !MAYBE_DELIMITER_ROW.test(delimiter)) return undefined
  let blockEnd = start
  while (blockEnd < lines.length && lines[blockEnd].trim()) blockEnd++
  const openingWs = lines[start].match(/^[ \t]*/)?.[0].length ?? 0
  const candidate = lines.slice(start, blockEnd).map(raw => stripLeadingWhitespace(raw, openingWs)).join('\n')
  const [first] = fromMarkdown(candidate, {
    extensions: [gfmTable()],
    mdastExtensions: [gfmTableFromMarkdown()],
  }).children
  if (first?.type !== 'table' || !first.position) return undefined
  let end = start + 2
  while (end < start + first.position.end.line && lines[end].includes('|')) end++
  return end
}

/** End (exclusive line index) of the run of `>` quote lines starting at
 *  `start`, or undefined when that line isn't one. A lazy continuation line
 *  (no `>`) is not followed: in pasted notes it is a reply, not the quote. */
const quoteEnd = (lines: readonly string[], start: number): number | undefined => {
  if (!lines[start].trim().startsWith('>')) return undefined
  let end = start + 1
  while (end < lines.length && lines[end].trim().startsWith('>')) end++
  return end
}

/** Remove up to `count` leading spaces/tabs from `raw`. */
const stripLeadingWhitespace = (raw: string, count: number): string => {
  let cut = 0
  while (cut < raw.length && cut < count && (raw[cut] === ' ' || raw[cut] === '\t')) cut++
  return raw.slice(cut)
}

/** Column a tab advances to, per CommonMark's tab-stop rule. Only the
 *  RELATIVE indent of two lines is ever compared, so any positive width
 *  nests a pure-tab outline correctly; the width decides where a tab
 *  lands when tabs and spaces are mixed. */
const TAB_STOP = 4;

function getIndentationLevel(line: string): number {
  // Measure the visual COLUMN of the first non-whitespace char, not the
  // character count: counting characters reads one tab as zero indent
  // (floor(1/2)) and flattens tab-indented outlines, which is the shape
  // most editors and outliner exports emit. 2 columns = 1 level.
  const indent = line.match(/^\s*/)?.[0] ?? '';
  let column = 0;
  for (const char of indent) {
    column = char === '\t' ? (Math.floor(column / TAB_STOP) + 1) * TAB_STOP : column + 1;
  }
  return Math.floor(column / 2);
}
