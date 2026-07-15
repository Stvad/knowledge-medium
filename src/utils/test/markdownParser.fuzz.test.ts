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
 *   the two-pass algorithm, not from understanding its indent/header/list
 *   nesting rules:
 *     - Pass 1 (markdownParser.ts:60-164) walks `lines` index-based and
 *       always advances `idx`, so it terminates.
 *     - Pass 2 (markdownParser.ts:180-205) assigns `parentId` only from
 *       `parentStack[level - 1]`, which — if set — was written by a
 *       strictly earlier iteration of the very same loop (it can only be
 *       overwritten going forward). So `parentId`, when defined, always
 *       names a block already pushed to `blocks`. That gives acyclicity
 *       for free — no need to model the context-stack nesting rules to
 *       assert it.
 *     - Sibling `orderKey`s come from repeated `keyAtEnd(lastOrderKey)`
 *       calls (per parent, or the `rootLastKey` cursor for root-level
 *       siblings) in document order — asserted, not just assumed, since it
 *       depends on `fractional-indexing-jittered` actually being monotone.
 *
 * - Structured round-trip on a *known-good* class (well-formed bullet
 *   outlines with single-line, structure-free content): the (depth,
 *   content) sequence recovered by walking `parentId` links must equal the
 *   input outline exactly. This is a stronger, semantic oracle, but only
 *   sound on inputs where indentation is the *only* nesting signal and all
 *   lines are the same type (`ul-item`) — see the code-cited proof in the
 *   docblock above the generator below.
 *
 * - Fenced-code isolation: the fence is documented (markdownParser.ts:76-84)
 *   to always become exactly one block, with inner lines never reinterpreted
 *   as structure — checked directly.
 */
import { describe, it, expect } from 'vitest'
import fc from 'fast-check'
import { fuzzParams } from '@/test/fuzz'
import { lineFragmentArb } from '@/test/arbitraries/markdownSoup'
import { parseMarkdownToBlocks, type ParsedBlock } from '../markdownParser'

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
          // (markdownParser.ts:190-194: parentStack[level-1] can only
          // hold an id written by a prior loop iteration).
          if (b.parentId !== undefined) {
            expect(emittedBefore.has(b.parentId)).toBe(true)
          }

          // Sibling orderKeys strictly ascend in emission order
          // (markdownParser.ts:193/196: each sibling's key is
          // keyAtEnd(previous sibling's key)).
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
// `- content`, i.e. type 'ul-item', so only Case A / B3 / Case C of the
// context-stack popping logic apply — markdownParser.ts:125,136-139,143):
//
// By induction, after processing outline entry i-1, the context stack
// holds root plus exactly one node per level 0..depth[i-1], with
// rawIndent === level at every node (each push uses
// rawIndent = currentLineRawIndent = depth, level = parent.level + 1,
// and depth only ever grows by exactly 1 per step here). For entry i:
//   - depth[i] = depth[i-1] + 1: current indent > stack-top indent →
//     Case A, break immediately → level = depth[i-1] + 1 = depth[i].
//   - depth[i] <= depth[i-1]: same/less indent pops (B3 for ties, Case C
//     for outdents) until the stack top has rawIndent = depth[i] - 1 (or
//     just root, for depth[i] = 0) — which exists by the contiguous-stack
//     invariant → level = depth[i].
// So the first-pass `level` sequence equals the input `depth` sequence
// exactly. The second pass (markdownParser.ts:180-205) walks that same
// kind of depth-like sequence with an analogous parentStack, so the
// parent-child shape it builds mirrors it 1:1.
//
// Content: rendering `'  '.repeat(depth) + '- ' + content` means
// `trimmedLine === '-' + ' ' + content` exactly (indentation is pure
// leading whitespace, content has no leading/trailing whitespace or `\n`
// per the generator below), so the ul-item regex captures `content` back
// verbatim.

const outlineContentArb = fc
  .string({minLength: 1, maxLength: 12})
  .map(s => s.trim())
  // Non-empty after trim (an empty capture group collapses the marker —
  // `'- '.trim()` is `'-'`, which doesn't match the ul-item regex at all
  // and falls through to type 'text' with content '-', breaking the
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

const outlineArb = depthSequenceArb.chain(depths =>
  fc.tuple(
    fc.constant(depths),
    fc.array(outlineContentArb, {minLength: depths.length, maxLength: depths.length}),
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
      fc.property(outlineArb, ([depths, contents]) => {
        const lines = depths.map((d, i) => '  '.repeat(d) + '- ' + contents[i])
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
// markdownParser.ts:76-84: a fence is consumed as ONE block from its
// opening line through the closing fence (or EOF); inner lines are never
// reinterpreted as list markers / headers.

describe('parseMarkdownToBlocks: fenced-code isolation', () => {
  it('a fence with adversarial inner lines is always exactly one block, verbatim', () => {
    const fenceCharArb = fc.constantFrom('`', '~')
    const fenceLenArb = fc.integer({min: 3, max: 5})
    // No backtick/tilde inside, so no inner line can ever match the
    // closing-fence regex and truncate the block early — but otherwise
    // unconstrained (may embed \n, list markers, headers, tabs, ...).
    const innerLineArb = fc.string({maxLength: 10}).map(s => s.replace(/[`~]/g, '.'))
    // Single physical, non-empty, fence-char-free prose line, restricted
    // to the parser's plain 'text' line-type (no leading `#` header
    // marker, no `- `/`* `/`+ ` or `N. ` list marker). This matters: a
    // header nests any FOLLOWING same-indent non-header line as its CHILD
    // (markdownParser.ts:128-129, B1 — also see the
    // 'places content underneath a header as its child' unit test), so a
    // '#' prelude would make the fence block (and postlude) its children
    // rather than root siblings. Excluding header/list-marker prefixes
    // keeps prelude/fence/postlude at the same 'text' type, which pops as
    // ROOT siblings (B4) — the structure this property assumes.
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
