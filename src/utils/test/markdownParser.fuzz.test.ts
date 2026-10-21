// @vitest-environment node
/**
 * Fuzz suite for `parseMarkdownToBlocks` — see `src/test/fuzz.ts` for the
 * smoke/deep tier mechanics.
 *
 * Oracles:
 *
 * - Soundness on adversarial input (never throws, forest is acyclic with
 *   every `parentId` pointing at an earlier-emitted block, sibling
 *   `orderKey`s strictly ascending). This follows from the *structure* of
 *   the lex → nest → flatten pipeline, not from understanding its
 *   indent/header/list nesting rules:
 *     - `lexMarkdownLines` walks `lines` index-based and always advances
 *       `idx`, so it terminates.
 *     - `outlineFromTokens` builds a tree, and `parsedBlocksFromOutline`
 *       walks it pre-order, minting a block's id before queueing its
 *       children with that id as their `parentId`. So `parentId`, when
 *       defined, always names a block already pushed to `blocks`. That
 *       gives acyclicity for free — no need to model the nesting rules to
 *       assert it.
 *     - Sibling `orderKey`s come from repeated `keyAtEnd(lastOrderKey)`
 *       calls per parent (root-level siblings included) in document order
 *       — asserted, not just assumed, since it depends on
 *       `fractional-indexing-jittered` actually being monotone.
 *
 * - Structured round-trip on a *known-good* class (well-formed bullet
 *   outlines with single-line, structure-free content): the (depth,
 *   content) sequence recovered by walking `parentId` links must equal the
 *   input outline exactly. This is a stronger, semantic oracle, but only
 *   sound on inputs where indentation is the *only* nesting signal and all
 *   lines are the same kind (`list-item`) — see the proof in the docblock
 *   above the generator below.
 *
 * - Fenced-code isolation: a fence always becomes exactly one block, with
 *   inner lines never reinterpreted as structure — checked directly.
 *
 * - Outline flattening: `parsedBlocksFromOutline` preserves an arbitrary
 *   tree exactly — the shape every pre-built paste (clipboard HTML) relies on.
 */
import { describe, it, expect } from 'vitest'
import fc from 'fast-check'
import { fuzzParams } from '@/test/fuzz'
import { lineFragmentArb } from '@/test/arbitraries/markdownSoup'
import { parseMarkdownToBlocks, parsedBlocksFromOutline, type OutlineNode, type ParsedBlock } from '../markdownParser'

// ──── Property 1: never throws + valid forest on adversarial soup ────
//
// Fragment-level generators (indentArb/bulletMarkerArb/headerMarkerArb/
// fenceMarkerArb/wordArb/lineFragmentArb) live in
// `src/test/arbitraries/markdownSoup.ts`, shared with
// `operations.fuzz.test.ts` — see that module's docblock for why sharing
// the corpus is a coverage feature, not just dedup. Composing fragments
// into a document (below) is this suite's own concern.

const soupArb = fc.array(lineFragmentArb, {maxLength: 15}).map(lines => lines.join('\n'))

describe('parseMarkdownToBlocks: adversarial soup', () => {
  it('never throws and produces an acyclic forest with ascending sibling orderKeys', () => {
    fc.assert(
      fc.property(soupArb, text => {
        const blocks = parseMarkdownToBlocks(text)
        expect(Array.isArray(blocks)).toBe(true)

        const emittedBefore = new Set<string>()
        const lastSiblingKey = new Map<string | undefined, string>()

        for (const b of blocks) {
          // parentId, if set, must name a block emitted strictly earlier
          // (a pre-order walk emits a parent before its children).
          if (b.parentId !== undefined) {
            expect(emittedBefore.has(b.parentId)).toBe(true)
          }

          // Sibling orderKeys strictly ascend in emission order (each
          // sibling's key is keyAtEnd(previous sibling's key)).
          const prevKey = lastSiblingKey.get(b.parentId)
          if (prevKey !== undefined) {
            expect(b.orderKey > prevKey).toBe(true)
          }
          lastSiblingKey.set(b.parentId, b.orderKey)

          emittedBefore.add(b.id)
        }
      }),
      fuzzParams(120),
    )
  })
})

// ──── Property 2: structured round-trip on well-formed bullet outlines ────
//
// Proof sketch that the round-trip holds for this generator (all lines are
// `- content`, i.e. kind 'list-item', so `nestsAtSameIndent` is always false
// and only indentation decides — `outlineFromTokens`):
//
// Write I(d) for the indent `getIndentationLevel` measures on a line the
// generator renders at outline depth d, i.e. on `unit.repeat(d)`. I is
// strictly increasing in d for every unit the generator picks, since each
// further unit advances the column by at least one. That is all this
// argument needs — never I(d) === d — which is what lets the property run
// over tab units as well as space ones.
//
// By induction, after processing outline entry i-1, the open stack holds
// exactly one node per level 0..depth[i-1], the node at level d carrying
// indent I(d). For entry i:
//   - depth[i] = depth[i-1] + 1: current indent > stack-top indent →
//     nests immediately → depth[i-1] + 1 = depth[i].
//   - depth[i] <= depth[i-1]: same/less indent pops (ties are siblings)
//     until the stack top has indent I(depth[i] - 1) — the deepest node
//     still shallower than I(depth[i]), since I is strictly increasing — or
//     the stack is empty, for depth[i] = 0.
// So the tree's depths equal the input `depth` sequence exactly, and the
// pre-order flattening (Property 4) preserves them.
//
// Content: rendering `unit.repeat(depth) + '- ' + content` means
// `trimmed === '-' + ' ' + content` exactly (indentation is pure leading
// whitespace, content has no leading/trailing whitespace or `\n` per the
// generator below), so the bullet regex captures `content` back verbatim.

const outlineContentArb = fc
  .string({minLength: 1, maxLength: 12})
  .map(s => s.trim())
  // Non-empty after trim (an empty capture group collapses the marker —
  // `'- '.trim()` is `'-'`, which doesn't match the bullet regex at all
  // and falls through to a paragraph with content '-', breaking the
  // 1-rendered-line-per-outline-entry assumption); no `\n` (would add
  // physical lines the outline doesn't account for); no leading
  // structure-like char (defensive — see docblock; not strictly required
  // since the fixed `- ` prefix already decides the line's type, but kept
  // to match the documented generator design).
  .filter(s => s.length > 0 && !s.includes('\n') && !/^[-*+#`~]/.test(s))

const depthSequenceArb = fc
  .array(fc.integer({min: 0, max: 6}), {minLength: 1, maxLength: 10})
  .map(raw => {
    const depths: number[] = []
    let prev = -1 // first entry clamps to min(raw[0], 0) === 0
    for (const r of raw) {
      const d = Math.min(r, prev + 1)
      depths.push(d)
      prev = d
    }
    return depths
  })

/** Whitespace rendering ONE outline level. Tab units are the point: the
 *  parser used to measure indentation in characters, so a tab-indented
 *  outline parsed as an all-roots flat list (#644). */
const indentUnitArb = fc.constantFrom('  ', '    ', '\t', '\t\t')

const outlineArb = depthSequenceArb.chain(depths =>
  fc.tuple(
    fc.constant(depths),
    fc.array(outlineContentArb, {minLength: depths.length, maxLength: depths.length}),
    indentUnitArb,
  ),
)

/** depth of a parsed block, by walking parentId links to the root. */
const depthOf = (block: ParsedBlock, byId: Map<string, ParsedBlock>): number => {
  let depth = 0
  let cur = block
  while (cur.parentId !== undefined) {
    const parent = byId.get(cur.parentId)
    if (!parent) throw new Error('dangling parentId')
    depth++
    cur = parent
  }
  return depth
}

describe('parseMarkdownToBlocks: bullet-outline round-trip', () => {
  it('recovers the exact (depth, content) sequence for a well-formed outline', () => {
    fc.assert(
      fc.property(outlineArb, ([depths, contents, unit]) => {
        const lines = depths.map((d, i) => unit.repeat(d) + '- ' + contents[i])
        const blocks = parseMarkdownToBlocks(lines.join('\n'))

        expect(blocks).toHaveLength(depths.length)
        const byId = new Map(blocks.map(b => [b.id, b]))
        const recovered = blocks.map(b => ({depth: depthOf(b, byId), content: b.content}))
        const expected = depths.map((d, i) => ({depth: d, content: contents[i]}))
        expect(recovered).toEqual(expected)
      }),
      fuzzParams(120),
    )
  })
})

// ──── Property 3: fenced code is never split / reinterpreted ────
//
// `fencedCodeEnd`: a fence is consumed as ONE block from its opening line
// through the closing fence (or EOF); inner lines are never reinterpreted as
// list markers / headers.

describe('parseMarkdownToBlocks: fenced-code isolation', () => {
  it('a fence with adversarial inner lines is always exactly one block, verbatim', () => {
    const fenceCharArb = fc.constantFrom('`', '~')
    const fenceLenArb = fc.integer({min: 3, max: 5})
    // No backtick/tilde inside, so no inner line can ever match the
    // closing-fence regex and truncate the block early — but otherwise
    // unconstrained (may embed \n, list markers, headers, tabs, ...).
    const innerLineArb = fc.string({maxLength: 10}).map(s => s.replace(/[`~]/g, '.'))
    // Single physical, non-empty, fence-char-free prose line, restricted
    // to the parser's 'paragraph' kind (no leading `#` header marker, no
    // `- `/`* `/`+ ` or `N. ` list marker). This matters: a header nests
    // any FOLLOWING same-indent non-header line as its CHILD
    // (`nestsAtSameIndent` — also see the 'places content underneath a
    // header as its child' unit test), so a '#' prelude would make the
    // fence block (and postlude) its children rather than root siblings.
    // Excluding those prefixes keeps prelude, fence and postlude ROOT
    // siblings — the structure this property assumes.
    const proseLineArb = fc
      .string({minLength: 1, maxLength: 8})
      .map(s => s.replace(/[`~\n]/g, '.').trim())
      .filter(s => s.length > 0)
      .filter(s => !s.startsWith('#'))
      .filter(s => !/^[-*+]\s+/.test(s))
      .filter(s => !/^\d+\.\s+/.test(s))

    fc.assert(
      fc.property(
        fenceCharArb,
        fenceLenArb,
        fc.array(innerLineArb, {maxLength: 6}),
        proseLineArb,
        proseLineArb,
        (ch, len, innerLines, prelude, postlude) => {
          const fence = ch.repeat(len)
          const text = [prelude, fence, ...innerLines, fence, postlude].join('\n')
          const blocks = parseMarkdownToBlocks(text)

          expect(blocks).toHaveLength(3)
          expect(blocks.every(b => b.parentId === undefined)).toBe(true)
          expect(blocks[1].content).toBe([fence, ...innerLines, fence].join('\n'))
        },
      ),
      fuzzParams(80),
    )
  })
})

// ──── Property 4: flattening preserves an arbitrary outline ────
//
// `parsedBlocksFromOutline` is the one path every paste takes to blocks —
// the markdown parse and a pre-built (clipboard HTML) tree alike — so any
// tree must come back with the same shape and content, in pre-order.

describe('parsedBlocksFromOutline: preserves the tree', () => {
  const {tree: treeArb} = fc.letrec<{tree: OutlineNode[]}>(tie => ({
    tree: fc.array(
      fc.record({
        // Unconstrained: content is never re-parsed on this path.
        content: fc.string({maxLength: 6}),
        children: fc.oneof({depthSize: 'small'}, fc.constant([]), tie('tree')),
      }),
      {maxLength: 4},
    ),
  }))

  const rebuild = (blocks: ParsedBlock[], parentId: string | undefined): OutlineNode[] =>
    blocks
      .filter(block => block.parentId === parentId)
      .sort((a, b) => (a.orderKey < b.orderKey ? -1 : a.orderKey > b.orderKey ? 1 : 0))
      .map(block => ({content: block.content, children: rebuild(blocks, block.id)}))

  it('rebuilding from parentId + orderKey yields the input tree', () => {
    fc.assert(
      fc.property(treeArb, tree => {
        const blocks = parsedBlocksFromOutline(tree)
        expect(rebuild(blocks, undefined)).toEqual(tree)
      }),
      fuzzParams(120),
    )
  })
})
