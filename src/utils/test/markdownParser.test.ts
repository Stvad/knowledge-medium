import { describe, it, expect } from 'vitest'
import { parseMarkdownToBlocks, type ParsedBlock } from '@/utils/markdownParser'

/** Find the unique block whose content matches `content`. Throws on
 *  missing or duplicate matches. */
const findByContent = (blocks: ParsedBlock[], content: string): ParsedBlock => {
  const matches = blocks.filter(b => b.content === content)
  if (matches.length === 0) throw new Error(`No block with content "${content}"`)
  if (matches.length > 1) throw new Error(`Multiple blocks with content "${content}"`)
  return matches[0]
}

/** Children of `parent` derived from `parentId` pointers, ordered by
 *  `orderKey`. The new ParsedBlock shape has no childIds — this is the
 *  source of truth. */
const childrenOf = (blocks: ParsedBlock[], parent: ParsedBlock): ParsedBlock[] => {
  return blocks
    .filter(b => b.parentId === parent.id)
    .sort((a, b) => (a.orderKey < b.orderKey ? -1 : a.orderKey > b.orderKey ? 1 : 0))
}

const isRoot = (block: ParsedBlock): boolean => block.parentId === undefined

describe('parseMarkdownToBlocks', () => {
  it('parses two adjacent lines as siblings at root', () => {
    const blocks = parseMarkdownToBlocks(`
First line
Second line`)

    expect(blocks).toHaveLength(2)
    expect(blocks.every(isRoot)).toBe(true)
    expect(blocks.map(b => b.content)).toEqual(['First line', 'Second line'])
  })

  it('uses indentation to derive parent-child relationships', () => {
    const blocks = parseMarkdownToBlocks(`
Parent
  Child
    Grandchild`)

    const parent = findByContent(blocks, 'Parent')
    const child = findByContent(blocks, 'Child')
    const grand = findByContent(blocks, 'Grandchild')

    expect(isRoot(parent)).toBe(true)
    expect(child.parentId).toBe(parent.id)
    expect(grand.parentId).toBe(child.id)
  })

  it('strips list markers, preserving content text', () => {
    const blocks = parseMarkdownToBlocks(`
- First item
- Second item
  - Nested item`)

    expect(blocks).toHaveLength(3)
    const item1 = findByContent(blocks, 'First item')
    const item2 = findByContent(blocks, 'Second item')
    const nested = findByContent(blocks, 'Nested item')

    expect(isRoot(item1)).toBe(true)
    expect(isRoot(item2)).toBe(true)
    expect(nested.parentId).toBe(item2.id)
  })

  it('handles deep list nesting (- a / - b / - c / - d)', () => {
    const blocks = parseMarkdownToBlocks(`
- a
    - b
    - c
        - d`)

    expect(blocks).toHaveLength(4)
    const a = findByContent(blocks, 'a')
    const b = findByContent(blocks, 'b')
    const c = findByContent(blocks, 'c')
    const d = findByContent(blocks, 'd')

    expect(isRoot(a)).toBe(true)
    expect(b.parentId).toBe(a.id)
    expect(c.parentId).toBe(a.id)
    expect(d.parentId).toBe(c.id)
    // siblings preserve markdown order via orderKey
    expect(childrenOf(blocks, a).map(x => x.content)).toEqual(['b', 'c'])
  })

  it('skips empty lines (non-content) and continues sibling sequence', () => {
    const blocks = parseMarkdownToBlocks(`
First line

Second line`)

    expect(blocks.map(b => b.content)).toEqual(['First line', 'Second line'])
    expect(blocks.every(isRoot)).toBe(true)
  })

  it('mixes free-form lines and list markers under the same parent', () => {
    const blocks = parseMarkdownToBlocks(`
Root
  - First item
    - Nested item
  Second item`)

    const root = findByContent(blocks, 'Root')
    const item1 = findByContent(blocks, 'First item')
    const nested = findByContent(blocks, 'Nested item')
    const item2 = findByContent(blocks, 'Second item')

    expect(isRoot(root)).toBe(true)
    expect(item1.parentId).toBe(root.id)
    expect(item2.parentId).toBe(root.id)
    expect(nested.parentId).toBe(item1.id)
    expect(childrenOf(blocks, root).map(x => x.content)).toEqual(['First item', 'Second item'])
  })

  it('preserves numbered-list markers in content', () => {
    const blocks = parseMarkdownToBlocks(`
1. First item
2. Second item
   1. Nested item`)

    expect(blocks.map(b => b.content)).toEqual([
      '1. First item',
      '2. Second item',
      '1. Nested item',
    ])
    const second = findByContent(blocks, '2. Second item')
    const nested = findByContent(blocks, '1. Nested item')
    expect(nested.parentId).toBe(second.id)
  })

  it('preserves the leading # on headers as part of content', () => {
    const blocks = parseMarkdownToBlocks('# Header 1')
    expect(blocks).toHaveLength(1)
    expect(blocks[0].content).toBe('# Header 1')
    expect(isRoot(blocks[0])).toBe(true)
  })

  it('nests headers by level: ## under #', () => {
    const blocks = parseMarkdownToBlocks(`
# Header 1
## Header 2`)

    const h1 = findByContent(blocks, '# Header 1')
    const h2 = findByContent(blocks, '## Header 2')
    expect(isRoot(h1)).toBe(true)
    expect(h2.parentId).toBe(h1.id)
  })

  it('places content underneath a header as its child (indented)', () => {
    const blocks = parseMarkdownToBlocks(`
# Header 1
  Content under header 1
## Header 2
  Content under header 2`)

    const h1 = findByContent(blocks, '# Header 1')
    const text1 = findByContent(blocks, 'Content under header 1')
    const h2 = findByContent(blocks, '## Header 2')
    const text2 = findByContent(blocks, 'Content under header 2')

    expect(text1.parentId).toBe(h1.id)
    expect(h2.parentId).toBe(h1.id)
    expect(text2.parentId).toBe(h2.id)
  })

  it('treats a non-indented list item under a header as its child', () => {
    const blocks = parseMarkdownToBlocks(`
# Header
- List item`)

    const h = findByContent(blocks, '# Header')
    const item = findByContent(blocks, 'List item')
    expect(item.parentId).toBe(h.id)
  })

  it('chains deeper headers in level order: ### under ## under #', () => {
    const blocks = parseMarkdownToBlocks(`
# Header 1
## Header 2
### Header 3`)

    const h1 = findByContent(blocks, '# Header 1')
    const h2 = findByContent(blocks, '## Header 2')
    const h3 = findByContent(blocks, '### Header 3')
    expect(h2.parentId).toBe(h1.id)
    expect(h3.parentId).toBe(h2.id)
  })

  it('emits orderKey values that sort siblings in markdown order', () => {
    const blocks = parseMarkdownToBlocks(`
- a
- b
- c`)

    expect(blocks.every(isRoot)).toBe(true)
    const sorted = [...blocks].sort((x, y) =>
      x.orderKey < y.orderKey ? -1 : x.orderKey > y.orderKey ? 1 : 0,
    )
    expect(sorted.map(b => b.content)).toEqual(['a', 'b', 'c'])
  })

  it('returns a single block for a single line of input', () => {
    const blocks = parseMarkdownToBlocks('Single line')
    expect(blocks).toHaveLength(1)
    expect(blocks[0].content).toBe('Single line')
    expect(isRoot(blocks[0])).toBe(true)
  })

  describe('fenced code blocks', () => {
    it('keeps a fenced code block as ONE block with fences intact', () => {
      const blocks = parseMarkdownToBlocks('```js\nconst x = 1\n```')
      expect(blocks).toHaveLength(1)
      expect(blocks[0].content).toBe('```js\nconst x = 1\n```')
      expect(isRoot(blocks[0])).toBe(true)
    })

    it('does not interpret list markers / headers inside a fence', () => {
      const blocks = parseMarkdownToBlocks('```\n- not a bullet\n# not a header\n```')
      expect(blocks).toHaveLength(1)
      expect(blocks[0].content).toBe('```\n- not a bullet\n# not a header\n```')
    })

    it('surrounding prose stays separate from the fence', () => {
      const blocks = parseMarkdownToBlocks('Here:\n```\ncode\n```\ndone')
      expect(blocks.map(b => b.content)).toEqual(['Here:', '```\ncode\n```', 'done'])
      expect(blocks.every(isRoot)).toBe(true)
    })

    it('nests an indented fence under a bullet and strips the opening indent', () => {
      const blocks = parseMarkdownToBlocks('- step\n  ```\n  code\n  ```')
      const step = findByContent(blocks, 'step')
      const fence = findByContent(blocks, '```\ncode\n```')
      expect(isRoot(step)).toBe(true)
      expect(fence.parentId).toBe(step.id)
    })

    it('closes an unclosed fence at EOF', () => {
      const blocks = parseMarkdownToBlocks('intro\n```\ncode here')
      expect(blocks.map(b => b.content)).toEqual(['intro', '```\ncode here'])
    })

    it('a longer ```` fence wraps inner ``` and closes only on a matching-length fence', () => {
      // 4-backtick fence around content that itself contains a 3-backtick
      // block — the inner ``` must NOT close it.
      const input = '````\n```\ninner\n```\n````\nafter'
      const blocks = parseMarkdownToBlocks(input)
      expect(blocks.map(b => b.content)).toEqual(['````\n```\ninner\n```\n````', 'after'])
    })

    it('handles ~~~ tilde fences, keeping inner - and # lines whole', () => {
      const input = '~~~ts\n- not a bullet\n# not a header\n~~~'
      const blocks = parseMarkdownToBlocks(input)
      expect(blocks).toHaveLength(1)
      expect(blocks[0].content).toBe('~~~ts\n- not a bullet\n# not a header\n~~~')
    })

    it('a ~~~ fence is not closed by a ``` line (different fence char)', () => {
      const input = '~~~\n```\ninner\n```\n~~~'
      const blocks = parseMarkdownToBlocks(input)
      expect(blocks).toHaveLength(1)
      expect(blocks[0].content).toBe('~~~\n```\ninner\n```\n~~~')
    })
  })
})
