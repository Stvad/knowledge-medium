import { describe, expect, it } from 'vitest'
import type { Element, Root } from 'hast'
import { rehypeTrimBlockSeparators } from '@/markdown/blockSeparators.js'

const at = (line: number) => ({
  start: {line, column: 1, offset: 0},
  end: {line, column: 2, offset: 1},
})

const paragraph = (line: number): Element => ({
  type: 'element',
  tagName: 'p',
  properties: {},
  children: [{type: 'text', value: 'x'}],
  position: at(line),
})

/** The predicate that decides this is asymmetric — mistaking authored text for
 *  the serializer's DELETES it, while the reverse leaves a blank line — so the
 *  clause keeping authored whitespace out of it is pinned here rather than
 *  through markdown, which emits no such node for the parser to prove it on. */
describe('rehypeTrimBlockSeparators', () => {
  const between = (separator: Root['children'][number]): Root => ({
    type: 'root',
    children: [paragraph(1), separator, paragraph(2)],
  })

  it('never removes whitespace that carries a source position', () => {
    const tree = between({type: 'text', value: '\n', position: at(1)})

    rehypeTrimBlockSeparators()(tree)

    expect(tree.children).toHaveLength(3)
  })

  it('removes the serializer\'s own break between blocks the author did not space', () => {
    const tree = between({type: 'text', value: '\n'})

    rehypeTrimBlockSeparators()(tree)

    expect(tree.children.map(child => child.type)).toEqual(['element', 'element'])
  })
})
