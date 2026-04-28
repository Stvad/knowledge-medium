import { describe, expect, it } from 'vitest'
import { unified } from 'unified'
import remarkParse from 'remark-parse'
import { visit } from 'unist-util-visit'
import type { Root, RootContent } from 'mdast'
import { remarkWikilinks } from '../remark-wikilinks.ts'

interface WikilinkNode {
  type: 'wikilink'
  value: string
  children: RootContent[]
  data: {
    hName: string
    hProperties: { alias: string; blockId: string }
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

const wikilinkChildText = (link: WikilinkNode): string =>
  link.children
    .map(child => (child as { value?: string; children?: RootContent[] }).value
      ?? ((child as { children?: RootContent[] }).children
        ? wikilinkChildText({children: (child as { children: RootContent[] }).children} as WikilinkNode)
        : ''))
    .join('')

describe('remarkWikilinks', () => {
  describe('bare [[alias]] in text', () => {
    it('rewrites [[link]] into a wikilink node with alias and resolved blockId', () => {
      const tree = transform('See [[Foo]] for context.', {Foo: 'block-foo'})
      const links = collectWikilinks(tree)
      expect(links).toHaveLength(1)
      expect(links[0].data.hName).toBe('wikilink')
      expect(links[0].data.hProperties.alias).toBe('Foo')
      expect(links[0].data.hProperties.blockId).toBe('block-foo')
      expect(wikilinkChildText(links[0])).toBe('Foo')
    })

    it('emits an empty blockId when the resolver returns nothing', () => {
      const tree = transform('See [[Unknown]] here.', {})
      expect(collectWikilinks(tree)[0].data.hProperties.blockId).toBe('')
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
      expect(collectWikilinks(transform('Plain text without links'))).toHaveLength(0)
    })

    it('trims whitespace inside brackets', () => {
      const tree = transform('Hello [[  Spaced Alias  ]] world', {'Spaced Alias': 'sa'})
      const link = collectWikilinks(tree)[0]
      expect(link.data.hProperties.alias).toBe('Spaced Alias')
      expect(link.data.hProperties.blockId).toBe('sa')
    })

    it('does not rewrite inside inline code', () => {
      expect(collectWikilinks(transform('Inline `[[notlink]]` here'))).toHaveLength(0)
    })

    it('does not rewrite inside fenced code blocks', () => {
      expect(collectWikilinks(transform('```\n[[notlink]]\n```\n'))).toHaveLength(0)
    })

    it('emits a single span for nested [[a [[b]] c]]', () => {
      const tree = transform('Nested [[outer [[inner]] tail]] end')
      const links = collectWikilinks(tree)
      expect(links).toHaveLength(1)
      expect(links[0].data.hProperties.alias).toBe('outer [[inner]] tail')
    })
  })

  describe('link-form [display]([[alias]])', () => {
    it('rewrites the link into a wikilink with the display text as children', () => {
      const tree = transform('See [my page]([[Foo]]) here.', {Foo: 'block-foo'})
      const links = collectWikilinks(tree)
      expect(links).toHaveLength(1)
      expect(links[0].data.hProperties.alias).toBe('Foo')
      expect(links[0].data.hProperties.blockId).toBe('block-foo')
      expect(wikilinkChildText(links[0])).toBe('my page')
    })

    it('preserves rich children inside the display text', () => {
      const tree = transform('Read [the **bold** doc]([[Foo]]).', {Foo: 'x'})
      const link = collectWikilinks(tree)[0]
      expect(wikilinkChildText(link)).toBe('the bold doc')
    })

    it('leaves regular markdown links alone', () => {
      const tree = transform('A [normal](https://example.com) link.', {})
      expect(collectWikilinks(tree)).toHaveLength(0)
    })

    it('mixes link-form and bare-form on one line', () => {
      const tree = transform('Bare [[Foo]] and named [name]([[Bar]]).', {Foo: '1', Bar: '2'})
      const links = collectWikilinks(tree)
      expect(links.map(n => n.data.hProperties.alias)).toEqual(['Foo', 'Bar'])
      expect(wikilinkChildText(links[0])).toBe('Foo')
      expect(wikilinkChildText(links[1])).toBe('name')
    })

    it('handles spaced aliases that remark leaves as plain text', () => {
      // `[X]([[April 30th, 2026]])` — the space in the alias means remark
      // never produces a link node, so this lands in our text-form scan.
      const tree = transform(
        'Meeting [notes]([[April 30th, 2026]]) attached.',
        {'April 30th, 2026': 'block-date'},
      )
      const links = collectWikilinks(tree)
      expect(links).toHaveLength(1)
      expect(links[0].data.hProperties.alias).toBe('April 30th, 2026')
      expect(links[0].data.hProperties.blockId).toBe('block-date')
      expect(wikilinkChildText(links[0])).toBe('notes')
      expect(collectText(tree)).toContain('Meeting ')
      expect(collectText(tree)).toContain(' attached.')
    })

    it('handles multi-word aliases without commas', () => {
      const tree = transform('See [docs]([[Foo Bar]]) here.', {'Foo Bar': 'fb'})
      const links = collectWikilinks(tree)
      expect(links[0].data.hProperties.alias).toBe('Foo Bar')
      expect(wikilinkChildText(links[0])).toBe('docs')
    })

    it('does not mangle adjacent bare links sharing a paragraph with a spaced one', () => {
      const tree = transform(
        '[a]([[X]]) then [b]([[Long Y]]) then [[Z]] end',
        {X: 'x', 'Long Y': 'y', Z: 'z'},
      )
      const links = collectWikilinks(tree)
      expect(links.map(n => n.data.hProperties.alias)).toEqual(['X', 'Long Y', 'Z'])
      expect(links.map(wikilinkChildText)).toEqual(['a', 'b', 'Z'])
    })
  })
})
