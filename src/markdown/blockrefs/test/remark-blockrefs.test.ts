import { describe, expect, it } from 'vitest'
import { unified } from 'unified'
import remarkParse from 'remark-parse'
import { visit } from 'unist-util-visit'
import type { Root, RootContent } from 'mdast'
import { remarkBlockrefs } from '../remark-blockrefs.ts'

interface BlockrefNode {
  type: 'blockref'
  value: string
  children: RootContent[]
  data: {
    hName: string
    hProperties: { blockId: string; aliased?: boolean }
  }
}

const id = '550e8400-e29b-41d4-a716-446655440000'

const transform = (md: string) => {
  const processor = unified()
    .use(remarkParse)
    .use(remarkBlockrefs)
  const tree = processor.parse(md) as Root
  return processor.runSync(tree) as Root
}

const collectBlockrefs = (tree: Root): BlockrefNode[] => {
  const out: BlockrefNode[] = []
  visit(tree, (node) => {
    if ((node as { type: string }).type === 'blockref') out.push(node as unknown as BlockrefNode)
  })
  return out
}

const childText = (children: RootContent[]): string =>
  children
    .map(child => (child as { value?: string; children?: RootContent[] }).value
      ?? ((child as { children?: RootContent[] }).children
        ? childText((child as { children: RootContent[] }).children)
        : ''))
    .join('')

describe('remarkBlockrefs', () => {
  it('rewrites bare ((uuid)) into a blockref node', () => {
    const refs = collectBlockrefs(transform(`see ((${id}))`))
    expect(refs).toHaveLength(1)
    expect(refs[0].data.hProperties).toEqual({blockId: id})
    expect(childText(refs[0].children)).toBe(`((${id}))`)
  })

  it('rewrites [label](((uuid))) into an aliased blockref node', () => {
    const refs = collectBlockrefs(transform(`see [shortcut](((${id}))) now`))
    expect(refs).toHaveLength(1)
    expect(refs[0].data.hProperties).toEqual({blockId: id, aliased: true})
    expect(childText(refs[0].children)).toBe('shortcut')
  })

  it('preserves rich markdown children in the alias label', () => {
    const refs = collectBlockrefs(transform(`[**important** block](((${id})))`))
    expect(refs).toHaveLength(1)
    expect(childText(refs[0].children)).toBe('important block')
  })

  it('leaves ordinary markdown links alone', () => {
    expect(collectBlockrefs(transform('[site](https://example.com)'))).toHaveLength(0)
  })
})
