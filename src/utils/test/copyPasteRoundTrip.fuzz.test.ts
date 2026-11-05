// @vitest-environment node
/**
 * Fuzz suite for the in-app copy → paste round-trip: `serializeBlock` /
 * `serializeSelectedBlocks` (`src/utils/copy.ts`) write the clipboard text,
 * and a multi-line paste reads it back through `parseMarkdownToBlocks`
 * (`src/paste/decision.ts`: any `\n` makes the paste a `split`;
 * `src/paste/operations.ts` parses it). The oracle: the forest the parser
 * rebuilds (parentId + orderKey) equals the copied forest, content verbatim.
 *
 * Why it holds on the generated class: `createIndentedContent` writes every
 * block of a multi-block copy as `'  '.repeat(depth) + '- ' + content`, so
 * each line is a `list-item` token (`lineToken`'s bullet branch runs before
 * the fence/table/quote checks, which only see paragraphs), indentation is
 * the only nesting signal (`nestsAtSameIndent` is false between list items),
 * and the bullet capture returns the content. Unlike the parser suite's
 * round-trip, content here may START with markdown structure (`#`, `- `,
 * `>`, `|`, fences) or be empty — the copy prefix is what must make those
 * safe.
 *
 * Generator scope, each a deliberate restriction:
 * - Single-line content only. A multi-line block's continuation lines are
 *   indented under its bullet and read back as children: an open product
 *   decision, not fuzzed here. `\r` counts as a line break (the parser
 *   normalizes it); U+2028/U+2029 do not, and are drawn on purpose.
 * - Content equals its own `trim()`: the parser trims each line, so edge
 *   whitespace of a block does not survive a paste.
 * - A single copied root has at least one child: a lone childless block is
 *   copied bare and pasted as one line, which is not a parsed paste. Several
 *   roots may be childless; each is bulleted.
 */
import { describe, expect, it } from 'vitest'
import fc from 'fast-check'
import { fuzzParams, fuzzTestTimeout } from '@/test/fuzz'
import { codePointUnitArb } from '@/test/arbitraries/utf16'
import type { Block } from '@/data/block'
import type { Repo } from '@/data/repo'
import { serializeBlock, serializeSelectedBlocks } from '@/utils/copy'
import { parseMarkdownToBlocks } from '@/utils/markdownParser'
import { outlineOf } from './outline'

interface Node {
  content: string
  children: Node[]
}

/** Leading text that is markdown structure on a line of its own. */
const leadArb = fc.constantFrom(
  '', '', '', '- ', '* ', '+ ', '-', '*', '# ', '###### ', '#tag ', '1. ', '> ',
  '| a | b |', '```', '~~~', '\t',
)
/** Joins two runs of text: JS counts U+2028/U+2029 as line terminators (the
 *  parser splits on `\n` only), and `trim()` strips them at the edges, so a
 *  join is where they survive into the content. */
const midArb = fc.constantFrom('', '', ' ', '\u2028', '\u2029', '\u0085', ' | ', ' - ')
const textArb = fc.string({unit: codePointUnitArb, maxLength: 6})

const contentArb = fc
  .tuple(leadArb, textArb, midArb, textArb)
  .map(parts => parts.join('').replace(/[\r\n]/g, ' ').trim())

const {tree: treeArb} = fc.letrec<{tree: Node; forest: Node[]}>(tie => ({
  tree: fc.record({content: contentArb, children: tie('forest')}),
  forest: fc.oneof(
    {depthSize: 'small', withCrossShrink: true},
    fc.constant<Node[]>([]),
    fc.array(tie('tree'), {minLength: 1, maxLength: 3}),
  ),
}))

/** A lone copied root: one with children, so the copy is a parsed outline. */
const rootArb = fc
  .tuple(contentArb, fc.array(treeArb, {minLength: 1, maxLength: 3}))
  .map(([content, children]): Node => ({content, children}))

/** The rows `repo.query.subtree` hands `serializeBlock`: pre-order, each with
 *  its depth below the copied root. */
const subtreeRows = (root: Node): Array<{id: string; content: string; depth: number}> => {
  const rows: Array<{id: string; content: string; depth: number}> = []
  const walk = (node: Node, depth: number) => {
    rows.push({id: `b${rows.length}`, content: node.content, depth})
    node.children.forEach(child => walk(child, depth + 1))
  }
  walk(root, 0)
  return rows
}

const fakeRepo = (roots: readonly Node[]): Repo => {
  const repo = {
    block: (id: string) => ({
      id,
      repo,
      // `serializeBlock` reads only `block.id` and this query.
    }) as unknown as Block,
    query: {
      subtree: ({id}: {id: string}) => ({load: async () => subtreeRows(roots[Number(id)])}),
    },
  }
  return repo as unknown as Repo
}

const pasted = (markdown: string): Node[] => {
  // Only a multi-line paste is parsed; every copy generated here has two lines.
  expect(markdown).toContain('\n')
  return outlineOf(parseMarkdownToBlocks(markdown))
}

describe('copy → paste round-trip', () => {
  it('a copied subtree pastes back as the same tree', async () => {
    await fc.assert(
      fc.asyncProperty(rootArb, async root => {
        const repo = fakeRepo([root])
        const {markdown} = await serializeBlock(repo.block('0'))
        expect(pasted(markdown)).toEqual([root])
      }),
      fuzzParams(150),
    )
  }, fuzzTestTimeout())

  it('several copied subtrees paste back as the same forest, in order', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.oneof(
          fc.array(rootArb, {minLength: 1, maxLength: 4}),
          fc.array(treeArb, {minLength: 2, maxLength: 4}),
        ),
        async roots => {
        const repo = fakeRepo(roots)
        const {markdown} = await serializeSelectedBlocks(roots.map((_, i) => String(i)), repo)
        expect(pasted(markdown)).toEqual(roots)
      },
      ),
      fuzzParams(100),
    )
  }, fuzzTestTimeout())

  // The two parser rules this round-trip depends on, pinned outside the
  // sampled space.
  it('an empty block pastes back empty, not as a literal marker', async () => {
    const root: Node = {content: 'a', children: [{content: '', children: []}, {content: 'b', children: []}]}
    const {markdown} = await serializeBlock(fakeRepo([root]).block('0'))
    expect(pasted(markdown)).toEqual([root])
  })

  it('a U+2028 inside a block does not cut its content short', async () => {
    const root: Node = {content: 'a\u2028b', children: [{content: 'c\u2029d', children: []}]}
    const {markdown} = await serializeBlock(fakeRepo([root]).block('0'))
    expect(pasted(markdown)).toEqual([root])
  })

  it('a lone marker right under a prose line stays text', () => {
    expect(parseMarkdownToBlocks('Pros\n-\nCons').map(block => block.content))
      .toEqual(['Pros', '-', 'Cons'])
  })
})
