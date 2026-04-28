import { describe, expect, it } from 'vitest'
import { unified } from 'unified'
import remarkParse from 'remark-parse'
import { visit } from 'unist-util-visit'
import type { Root } from 'mdast'
import { remarkWikilinks } from '../remark-wikilinks.ts'

interface WikilinkNode {
  type: 'wikilink'
  value: string
  data: {
    hName: string
    hProperties: { alias: string }
    hChildren: { type: 'text'; value: string }[]
  }
}

const transform = (md: string) => {
  const processor = unified().use(remarkParse).use(remarkWikilinks)
  const tree = processor.parse(md) as Root
  return processor.runSync(tree) as Root
}

const collectWikilinks = (tree: Root): WikilinkNode[] => {
  const out: WikilinkNode[] = []
  visit(tree, (node) => {
    if ((node as { type: string }).type === 'wikilink') out.push(node as unknown as WikilinkNode)
  })
  return out
}

const collectText = (tree: Root): string[] => {
  const out: string[] = []
  visit(tree, 'text', (node) => out.push(node.value))
  return out
}

describe('remarkWikilinks', () => {
  it('rewrites a [[link]] into a wikilink mdast node with alias data', () => {
    const tree = transform('See [[Foo]] for context.')
    const links = collectWikilinks(tree)
    expect(links).toHaveLength(1)
    expect(links[0].data.hName).toBe('wikilink')
    expect(links[0].data.hProperties.alias).toBe('Foo')
    expect(links[0].data.hChildren[0].value).toBe('Foo')
  })

  it('handles multiple links on one line', () => {
    const tree = transform('A [[one]] and [[two]] on one line.')
    const aliases = collectWikilinks(tree).map(n => n.data.hProperties.alias)
    expect(aliases).toEqual(['one', 'two'])
  })

  it('preserves surrounding text', () => {
    const tree = transform('before [[Foo]] after')
    const texts = collectText(tree)
    expect(texts).toContain('before ')
    expect(texts).toContain(' after')
  })

  it('does not touch text without [[...]]', () => {
    const tree = transform('Plain text without links')
    expect(collectWikilinks(tree)).toHaveLength(0)
  })

  it('trims whitespace inside brackets', () => {
    const tree = transform('Hello [[  Spaced Alias  ]] world')
    const links = collectWikilinks(tree)
    expect(links[0].data.hProperties.alias).toBe('Spaced Alias')
  })

  it('does not rewrite inside inline code', () => {
    const tree = transform('Inline `[[notlink]]` here')
    expect(collectWikilinks(tree)).toHaveLength(0)
  })

  it('does not rewrite inside fenced code blocks', () => {
    const tree = transform('```\n[[notlink]]\n```\n')
    expect(collectWikilinks(tree)).toHaveLength(0)
  })

  it('emits a single span for nested [[a [[b]] c]]', () => {
    const tree = transform('Nested [[outer [[inner]] tail]] end')
    const links = collectWikilinks(tree)
    expect(links).toHaveLength(1)
    expect(links[0].data.hProperties.alias).toBe('outer [[inner]] tail')
  })
})
