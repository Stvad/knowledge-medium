import {describe, expect, it} from 'vitest'
import {unified} from 'unified'
import remarkParse from 'remark-parse'
import remarkGfm from 'remark-gfm'
import {visit} from 'unist-util-visit'
import {markdownExtensionsFacet} from '@/markdown/extensions'
import {resolveFacetRuntimeSync} from '@/facets/facet'
import type {Block} from '@/data/block'
import {referencesPlugin} from '../index'

const E = '22222222-2222-4222-8222-222222222222'
const markdownConfig = resolveFacetRuntimeSync(referencesPlugin).read(markdownExtensionsFacet)

const occurrences = (content: string, references: {alias: string; id: string}[] = []) => {
  const config = markdownConfig({
    block: {id: 'host'} as Block, blockContext: {}, input: {},
    data: {content, references, workspaceId: 'workspace'},
  })
  const processor = unified().use(remarkParse).use(remarkGfm).use(config.remarkPlugins)
  const tree = processor.runSync(processor.parse(content), content)
  const refs: {kind: string; target: unknown; id: unknown}[] = []
  visit(tree, node => {
    if (!['blockref', 'blockembed', 'pageembed'].includes(node.type)) return
    const {hProperties: props} = node.data as {hProperties: Record<string, unknown>}
    refs.push({kind: node.type, target: props.alias ?? props.blockId, id: props.occurrenceId})
  })
  return refs
}

describe('reference occurrence identities', () => {
  it.each([{kind: 'embed', bang: '!'}, {kind: 'ref', bang: ''}])('gives every interleaved block $kind a distinct id', ({bang}) => {
    const refs = occurrences(`![[A]] ${bang}((${E})) ![[B]] ${bang}((${E}))`)
    expect(refs).toHaveLength(4)
    expect(refs.every(ref => typeof ref.id === 'string')).toBe(true)
    expect(new Set(refs.map(ref => ref.id)).size).toBe(4)
  })

  it('keeps ids when text, unrelated targets or reference kinds change before them', () => {
    const content = `![[A]] !((${E})) ((${E})) ![[A]]`
    const before = occurrences(content)
    const after = occurrences(`prefix [[Longer name]] ![[Other]] ![[A]] **label** ((${E})) !((${E})) ((${E})) ![[A]]`)
    expect(after.filter(ref => ref.target === 'A' || ref.kind === 'blockembed'))
      .toEqual(before.filter(ref => ref.target === 'A' || ref.kind === 'blockembed'))
  })

  it('numbers bare and link-form block references together in document order', () => {
    const content = `((${E})) [label](((${E}))) ((${E}))`
    const refs = occurrences(content)
    expect(refs).toHaveLength(3)
    expect(new Set(refs.map(ref => ref.id)).size).toBe(3)
    expect(occurrences(`prefix ${content}`)).toEqual(refs)
    expect(occurrences(`((${E})) ((${E})) ((${E}))`)).toEqual(refs)
    const richLabel = occurrences(`[!((${E}))](((11111111-1111-4111-8111-111111111111))) !((${E}))`)
    expect(richLabel.filter(ref => ref.kind === 'blockembed'))
      .toEqual(occurrences(`!((${E})) !((${E}))`))
  })

  it('keeps unresolved aliases distinct and independent of their resolution', () => {
    const content = '![[A]] ![[B]] ![[A]] ![[a@example.com]] ![[a@example.com]]'
    const unresolved = occurrences(content)
    expect(unresolved).toHaveLength(5)
    expect(new Set(unresolved.map(ref => ref.id)).size).toBe(5)
    expect(occurrences(`prefix ${content}`, [{alias: 'A', id: E}, {alias: 'B', id: E}])).toEqual(unresolved)
  })

  it.each([{kind: 'embed', bang: '!'}, {kind: 'ref', bang: ''}])('ignores hidden block $kind nodes inside page-embed aliases', ({bang}) => {
    const ref = `${bang}((${E}))`
    expect(occurrences(`![[Other ${ref}]] ${ref}`).at(-1)).toEqual(occurrences(ref)[0])
  })
})
