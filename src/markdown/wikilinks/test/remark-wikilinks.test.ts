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
    hProperties: { alias: string; blockId: string }
    hChildren: { type: 'text'; value: string }[]
  }
}

const transform = (md: string, refs: Record<string, string> = {}) => {
  const processor = unified()
    .use(remarkParse)
    .use(remarkWikilinks, {resolveAlias: (alias: string) => refs[alias]})
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
  it('rewrites a [[link]] into a wikilink mdast node carrying alias and resolved blockId', () => {
    const tree = transform('See [[Foo]] for context.', {Foo: 'block-foo'})
    const links = collectWikilinks(tree)
    expect(links).toHaveLength(1)
    expect(links[0].data.hName).toBe('wikilink')
    expect(links[0].data.hProperties.alias).toBe('Foo')
    expect(links[0].data.hProperties.blockId).toBe('block-foo')
    expect(links[0].data.hChildren[0].value).toBe('Foo')
  })

  it('emits an empty blockId when the resolver returns nothing', () => {
    const tree = transform('See [[Unknown]] here.', {})
    const links = collectWikilinks(tree)
    expect(links[0].data.hProperties.blockId).toBe('')
  })

  it('handles multiple links on one line', () => {
    const tree = transform('A [[one]] and [[two]] on one line.', {one: '1', two: '2'})
    const links = collectWikilinks(tree)
    expect(links.map(n => n.data.hProperties.alias)).toEqual(['one', 'two'])
    expect(links.map(n => n.data.hProperties.blockId)).toEqual(['1', '2'])
  })

  it('preserves surrounding text', () => {
    const tree = transform('before [[Foo]] after', {Foo: 'x'})
    const texts = collectText(tree)
    expect(texts).toContain('before ')
    expect(texts).toContain(' after')
  })

  it('does not touch text without [[...]]', () => {
    const tree = transform('Plain text without links')
    expect(collectWikilinks(tree)).toHaveLength(0)
  })

  it('trims whitespace inside brackets', () => {
    const tree = transform('Hello [[  Spaced Alias  ]] world', {'Spaced Alias': 'sa'})
    const links = collectWikilinks(tree)
    expect(links[0].data.hProperties.alias).toBe('Spaced Alias')
    expect(links[0].data.hProperties.blockId).toBe('sa')
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
