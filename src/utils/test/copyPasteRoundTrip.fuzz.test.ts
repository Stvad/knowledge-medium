// @vitest-environment happy-dom
/**
 * Fuzz suite for the in-app copy → paste round-trip, from the real clipboard
 * writer (`copyBlockIdsToClipboard`) through the real paste decision and plan
 * on both surfaces. The oracle: what the paste would create is the copied
 * forest, content verbatim.
 *
 * The generator has no carve-outs: content may be empty, span lines, carry
 * edge whitespace or `\r`, hold whole fences, tables and quotes, start with
 * markdown structure, or hold unpaired surrogates (which the clipboard's
 * UTF-8 `Blob`s rewrite in the text, so they are written through a real one).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import fc from 'fast-check'
import { fuzzParams, fuzzTestTimeout } from '@/test/fuzz'
import { codePointUnitArb, utf16UnitArb } from '@/test/arbitraries/utf16'
import type { Block } from '@/data/block'
import type { Repo } from '@/data/repo'
import { readClipboardContent } from '@/paste/clipboard'
import { defaultPasteDecision } from '@/paste/decision'
import { planEditModeMultilinePaste, planSingleBlockPaste } from '@/paste/operations'
import { copyBlockIdsToClipboard } from '@/utils/copy'
import { parsedBlocksFromOutline, parseMarkdownToBlocks } from '@/utils/markdownParser'
import { outlineOf } from './outline'

/** happy-dom keeps every document its `DOMParser` parses, and each paste here
 *  parses one, so an uncapped deep run exhausts the heap. */
const MAX_RUNS = 5000
const cappedFuzzParams = <T>(smokeRuns: number): fc.Parameters<T> => {
  const params = fuzzParams<T>(smokeRuns)
  return {...params, numRuns: Math.min(params.numRuns ?? smokeRuns, MAX_RUNS)}
}

interface Node {
  content: string
  children: Node[]
}

/** Leading text that is markdown structure on a line of its own. */
const leadArb = fc.constantFrom(
  '', '', '', '- ', '* ', '+ ', '-', '*', '# ', '###### ', '#tag ', '1. ', '> ',
  '| a | b |', '```', '~~~', '\t', '  ',
)
const midArb = fc.constantFrom('', '', ' ', ' ', ' ', '\u0085', ' | ', ' - ')
const textArb = fc.oneof(
  fc.string({unit: codePointUnitArb, maxLength: 6}),
  fc.string({unit: utf16UnitArb, maxLength: 4}),
)
const lineArb = fc.tuple(leadArb, textArb, midArb, textArb).map(parts => parts.join(''))
const edgeArb = fc.constantFrom('', '', '', ' ', '   ', '\t', '\n', ' \n', '\n\n', '\r\n', '\r')
const wholeArb = fc.constantFrom(
  '```\ncode\n```',
  '```js\n- not a bullet\n\n  indented\n',
  '> quote\n> more',
  '| a | b |\n| - | - |\n| 1 | 2 |',
  '# heading\nbody',
  '   ',
  '\n',
)
const contentArb = fc.oneof(
  {weight: 1, arbitrary: fc.constant('')},
  {weight: 1, arbitrary: wholeArb},
  {
    weight: 6,
    arbitrary: fc
      .tuple(edgeArb, fc.array(lineArb, {minLength: 1, maxLength: 3}), edgeArb)
      .map(([before, lines, after]) => before + lines.join('\n') + after),
  },
)

const {tree: treeArb} = fc.letrec<{tree: Node; forest: Node[]}>(tie => ({
  tree: fc.record({content: contentArb, children: tie('forest')}),
  forest: fc.oneof(
    {depthSize: 'small', withCrossShrink: true},
    fc.constant<Node[]>([]),
    fc.array(tie('tree'), {minLength: 1, maxLength: 3}),
  ),
}))

/** The rows `repo.query.subtree` hands the copy: pre-order, each with its
 *  depth below the copied root. */
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
    // The copy reads only `block.id` and this query.
    block: (id: string) => ({id, repo}) as unknown as Block,
    query: {subtree: ({id}: {id: string}) => ({load: async () => subtreeRows(roots[Number(id)])})},
  }
  return repo as unknown as Repo
}

interface Clipboard {
  text: string
  html: string
}

let clipboard: Clipboard | null

const copied = async (roots: readonly Node[]): Promise<Clipboard> => {
  await copyBlockIdsToClipboard(roots.map((_, i) => String(i)), fakeRepo(roots))
  return clipboard!
}

const clipboardContent = ({text, html}: Clipboard) =>
  readClipboardContent({getData: type => (type === 'text/plain' ? text : type === 'text/html' ? html : '')})!

const pastedOnShell = (from: Clipboard): Node[] => {
  const content = clipboardContent(from)
  const decision = defaultPasteDecision({...content, intent: 'split', surface: 'shell'})
  if (decision.kind !== 'split') throw new Error(`unexpected ${decision.kind}`)
  return outlineOf(decision.blocks ? parsedBlocksFromOutline(decision.blocks) : parseMarkdownToBlocks(content.text))
}

/** A paste at the caret of an empty block, which becomes the first root. */
const pastedInEditor = (from: Clipboard): Node[] => {
  const content = clipboardContent(from)
  const decision = defaultPasteDecision({
    ...content,
    intent: 'split',
    surface: 'editor',
    caret: {line: 1, lineCount: 1, from: 0, to: 0},
  })
  if (decision.kind === 'media') throw new Error('unexpected media')
  if (decision.kind === 'single-block') {
    return [{content: planSingleBlockPaste(content.text, {from: 0, to: 0}).insert, children: []}]
  }
  const plan = planEditModeMultilinePaste(decision.blocks ?? content.text, '', {from: 0})
  if (!plan) throw new Error('nothing planned')
  return outlineOf(plan.parsed.map(block =>
    block.id === plan.absorbedRoot.id ? {...block, content: plan.targetContent} : block))
}

describe('copy → paste round-trip', () => {
  beforeEach(() => {
    clipboard = null
    vi.stubGlobal('ClipboardItem', class {
      constructor(readonly items: Record<string, Blob>) {}
    })
    vi.stubGlobal('navigator', {clipboard: {
      write: async ([{items}]: [{items: Record<string, Blob>}]) => {
        clipboard = {
          text: await items['text/plain'].text(),
          html: items['text/html'] ? await items['text/html'].text() : '',
        }
      },
    }})
  })
  afterEach(() => vi.unstubAllGlobals())

  it('a copied subtree pastes back as the same tree on both surfaces', async () => {
    await fc.assert(
      fc.asyncProperty(treeArb, async root => {
        const from = await copied([root])
        expect(pastedOnShell(from)).toEqual([root])
        expect(pastedInEditor(from)).toEqual([root])
      }),
      cappedFuzzParams(150),
    )
  }, fuzzTestTimeout())

  it('several copied subtrees paste back as the same forest, in order', async () => {
    await fc.assert(
      fc.asyncProperty(fc.array(treeArb, {minLength: 2, maxLength: 4}), async roots => {
        const from = await copied(roots)
        expect(pastedOnShell(from)).toEqual(roots)
        expect(pastedInEditor(from)).toEqual(roots)
      }),
      cappedFuzzParams(100),
    )
  }, fuzzTestTimeout())

  // The reported shapes, pinned outside the sampled space.
  it.each<[string, Node]>([
    ['a multi-line block keeps its children one level down', {content: 'a\nb', children: [{content: 'c', children: []}]}],
    ['a fence does not swallow the child after it', {content: '```\ncode\n```', children: [{content: 'c', children: []}]}],
    ['a block keeps its edge whitespace', {content: 'a', children: [{content: '  padded  ', children: []}]}],
    ['an empty block stays empty', {content: 'a\nb', children: [{content: '', children: []}, {content: 'c', children: []}]}],
    ['a lone bullet-shaped block keeps its marker', {content: '- foo', children: []}],
    ['a lone empty block stays a block', {content: '', children: []}],
    ['a U+2028 does not cut a block short', {content: 'a\u2028b', children: [{content: 'c\u2029d', children: []}]}],
  ])('%s', async (_, root) => {
    const from = await copied([root])
    expect(pastedOnShell(from)).toEqual([root])
    expect(pastedInEditor(from)).toEqual([root])
  })

  it('a lone marker right under a prose line stays text', () => {
    expect(parseMarkdownToBlocks('Pros\n-\nCons').map(block => block.content))
      .toEqual(['Pros', '-', 'Cons'])
  })
})
