// @vitest-environment node
/**
 * Fuzz suite for the pure paste planners in `src/paste/operations.ts` — see
 * `src/test/fuzz.ts` for the smoke/deep tier mechanics.
 *
 * Targets and their contracts:
 *
 * - `planSingleBlockPaste`: normalizes CRLF/CR to LF
 *   and otherwise passes `{from, to}` straight through — no `Math.max`/`min`
 *   clamping anywhere in the function, unlike its sibling below. Its one
 *   production call site (`CodeMirrorContentRenderer.tsx`) passes
 *   `editorView.state.selection.main`, a live CodeMirror `SelectionRange`
 *   that CodeMirror itself guarantees satisfies `0 <= from <= to <=
 *   doc.length` — an out-of-range/unordered pair is not reachable in
 *   production. So the arbitrary below generates only in-contract selections
 *   (`0 <= from <= to <= docLength`); it does not probe clamping behavior
 *   the function was never meant to have.
 *
 * - `planEditModeMultilinePaste` is the converse: it
 *   DOES clamp (`Math.max(0, Math.min(...))`), so its selection
 *   arbitrary deliberately includes out-of-range and unordered `{from, to}`
 *   (negative, past `currentContent.length`, `from > to`). Oracles, each
 *   cited at its assertion below:
 *     - never throws, and returns `null` exactly when the parsed paste has
 *       no root to absorb (a blank/whitespace-only paste).
 *     - `parsed` is the parser's full output in order — content sequence
 *       conservation, checked against a fresh `parseMarkdownToBlocks` call —
 *       with the text after the caret either glued onto its last block or
 *       appended as one block more. (ids/orderKeys are `uuidv4`/
 *       jittered-key random per call — see markdownParser.fuzz.test.ts's
 *       note on `fractional-indexing-jittered` — so only `content` is
 *       compared, never `id`/`orderKey`.)
 *     - effective from/to are clamped into `[0, currentContent.length]`.
 *     - `targetContent` always starts with `currentContent.slice(0,
 *       clampedFrom)`.
 *     - block syntax never shares a line with the text at the caret
 *       (`blockSyntaxOnLine`): a first root that opens with it is not
 *       absorbed after non-blank text, and non-blank text after the caret
 *       becomes a block of its own after a last block that closes with it.
 *       Otherwise the first root merges at the caret and the text after it
 *       lands on the end of the paste's last block, the edited one when the
 *       paste is one absorbed block.
 *     - the caret ends at the end of the pasted text: `focus` names the
 *       paste's last block, or is absent and `focusOffsetInTarget` points
 *       just before the text after the caret in `targetContent`.
 *     - fenced-code root: a multi-line absorbed root (an atomic token — the
 *       only parses that yield one block spanning newlines) is kept whole,
 *       in `targetContent` or in a block of its own — checked directly with
 *       a fence-only generator.
 *
 *   Left out: full conservation for the *single-line* absorbed-root case
 *   (i.e. proving `mergedFirstContent` — the first pasted line, bullet
 *   marker stripped, trailing `\r` stripped — appears verbatim in
 *   `targetContent`) would require reimplementing the private, unexported
 *   `editorContentForFirstPastedLine` helper test-side, which would just be
 *   restating its logic rather than checking it. That composition is
 *   already covered by the example-based tests in `operations.test.ts`
 *   ("merges the first line at the caret...", "parents children of the
 *   first pasted root..."). What IS checked here for every case, including
 *   single-line: the prefix/suffix reconstruction around whatever
 *   `mergedFirstContent` turns out to be, and full conservation of `parsed`
 *   (so nothing from the parse is silently dropped from the returned plan).
 *
 * - `pasteChordIntent`: totality only — classifies an
 *   arbitrary key-event-shaped record into `'split' | 'single-block' |
 *   null` and never throws.
 */
import { describe, it, expect } from 'vitest'
import fc from 'fast-check'
import { fuzzParams } from '@/test/fuzz'
import { lineFragmentArb } from '@/test/arbitraries/markdownSoup'
import { blockSyntaxOnLine, parseMarkdownToBlocks } from '@/utils/markdownParser'
import {
  pasteChordIntent,
  planEditModeMultilinePaste,
  planSingleBlockPaste,
  type EditModePasteSelection,
} from '../operations'

// ──── Shared pasted-text generator: line soup incl. bullets/headers/fences,
// mixed line endings, unicode, blank/empty. Fragment-level generators
// (indentArb/bulletMarkerArb/headerMarkerArb/fenceMarkerArb/wordArb/
// lineFragmentArb) live in `src/test/arbitraries/markdownSoup.ts`, shared
// with `markdownParser.fuzz.test.ts` — see that module's docblock for why
// sharing the corpus is a coverage feature, not just dedup. Mixed line
// endings (below) is this suite's own top-level composition. ────

const lineEndingArb = fc.constantFrom('\n', '\r\n', '\r')

/** Lines joined with independently-chosen line endings, so \n / \r\n / \r
 *  mixes land in one paste — exactly the normalization case
 *  `planSingleBlockPaste` documents handling. */
const lineSoupArb = fc.array(lineFragmentArb, {minLength: 1, maxLength: 12}).chain(lines =>
  fc.array(lineEndingArb, {minLength: lines.length - 1, maxLength: lines.length - 1}).map(seps => {
    let out = lines[0]
    for (let i = 1; i < lines.length; i++) out += seps[i - 1] + lines[i]
    return out
  }),
)

const pastedTextArb = fc.oneof(
  {arbitrary: fc.constant(''), weight: 1},
  {arbitrary: fc.constant('   \n\t\n  '), weight: 1}, // whitespace-only, no root to absorb
  {arbitrary: lineSoupArb, weight: 8},
)

// ──── planSingleBlockPaste ────

describe('planSingleBlockPaste', () => {
  // In-contract selections only — see docblock above for why out-of-range
  // inputs aren't meaningful here.
  const selectionArb = fc.integer({min: 0, max: 200}).chain(docLength =>
    fc.tuple(fc.integer({min: 0, max: docLength}), fc.integer({min: 0, max: docLength})).map(
      ([a, b]) => (a <= b ? {from: a, to: b} : {from: b, to: a}),
    ),
  )

  it('normalizes line endings, passes from/to through, cursor = from + insert.length, never throws', () => {
    fc.assert(
      fc.property(pastedTextArb, selectionArb, (pastedText, selection) => {
        const plan = planSingleBlockPaste(pastedText, selection)

        // `\r\n?` replaced with `\n`, so no bare \r or \r\n can survive
        // into `insert`.
        expect(plan.insert).not.toMatch(/\r/)

        // Pass-through, unchanged.
        expect(plan.from).toBe(selection.from)
        expect(plan.to).toBe(selection.to)

        // The caret lands after the insert.
        expect(plan.cursor).toBe(selection.from + plan.insert.length)
      }),
      fuzzParams(150),
    )
  })
})

// ──── planEditModeMultilinePaste ────

describe('planEditModeMultilinePaste', () => {
  const currentContentArb = fc.string({maxLength: 60})

  // Deliberately out-of-range / unordered: negative, past length, from > to,
  // and `to` sometimes omitted (optional per `EditModePasteSelection`).
  const rawFromToArb = fc.integer({min: -50, max: 250})
  const rawSelectionArb: fc.Arbitrary<EditModePasteSelection> = fc.record({
    from: rawFromToArb,
    to: fc.option(rawFromToArb, {nil: undefined}),
  })

  it(
    'never throws; clamps from/to; reconstructs prefix/suffix exactly; conserves `parsed` content',
    () => {
      fc.assert(
        fc.property(pastedTextArb, currentContentArb, rawSelectionArb, (pastedText, currentContent, selection) => {
          const plan = planEditModeMultilinePaste(pastedText, currentContent, selection)
          const fresh = parseMarkdownToBlocks(pastedText).map(b => b.content)

          if (fresh.length === 0) {
            // No root block to absorb.
            expect(plan).toBeNull()
            return
          }
          expect(plan).not.toBeNull()
          if (!plan) return

          const clampedFrom = Math.max(0, Math.min(selection.from, currentContent.length))
          const clampedTo = Math.max(clampedFrom, Math.min(selection.to ?? selection.from, currentContent.length))
          expect(clampedFrom).toBeGreaterThanOrEqual(0)
          expect(clampedFrom).toBeLessThanOrEqual(currentContent.length)
          expect(clampedTo).toBeGreaterThanOrEqual(clampedFrom)
          expect(clampedTo).toBeLessThanOrEqual(currentContent.length)

          const prefix = currentContent.slice(0, clampedFrom)
          const trueSuffix = currentContent.slice(clampedTo)
          const isBlank = (text: string) => text.trim() === ''
          const headSplits = !isBlank(prefix) && blockSyntaxOnLine(fresh[0], 'first')
          const tailSplits = !isBlank(trueSuffix) && blockSyntaxOnLine(fresh.at(-1)!, 'last')
          const tailIsTarget = fresh.length === 1 && !headSplits

          expect(plan.targetContent.startsWith(prefix)).toBe(true)
          expect(plan.absorbedRoot === undefined).toBe(headSplits)
          if (headSplits) expect(plan.targetContent).toBe(prefix)
          else expect(plan.absorbedRoot).toBe(plan.parsed[0])

          // Conservation, with the text after the caret placed branch-exact.
          // ids/orderKeys are randomized per call (uuidv4 / jittered keys), so
          // compare content only.
          const contents = plan.parsed.map(b => b.content)
          if (tailSplits) {
            expect(contents).toEqual([...fresh, trueSuffix])
          } else if (tailIsTarget) {
            expect(contents).toEqual(fresh)
          } else {
            expect(contents).toEqual([...fresh.slice(0, -1), `${fresh.at(-1)}${trueSuffix}`])
          }

          const suffixOnTarget = tailIsTarget && !tailSplits
          expect(plan.targetContent.endsWith(suffixOnTarget ? trueSuffix : '')).toBe(true)
          expect(plan.focusOffsetInTarget).toBe(plan.targetContent.length - (suffixOnTarget ? trueSuffix.length : 0))
          expect(plan.focus).toEqual(tailIsTarget
            ? undefined
            : {parsedId: plan.parsed[fresh.length - 1].id, offset: fresh.at(-1)!.length})
        }),
        fuzzParams(150),
      )
    },
  )

  describe('fenced-code absorbed root keeps the full body', () => {
    // Single fenced block, no prelude/postlude, so the parse yields exactly
    // one (multi-line) root — adapted from the fence generator in
    // markdownParser.fuzz.test.ts.
    const fenceCharArb = fc.constantFrom('`', '~')
    const fenceLenArb = fc.integer({min: 3, max: 5})
    const innerLineArb = fc.string({maxLength: 10}).map(s => s.replace(/[`~]/g, '.'))
    const fenceTextArb = fc
      .tuple(fenceCharArb, fenceLenArb, fc.array(innerLineArb, {maxLength: 6}))
      .map(([ch, len, innerLines]) => {
        const fence = ch.repeat(len)
        return [fence, ...innerLines, fence].join('\n')
      })

    it('the fence body is kept verbatim in the block that holds it', () => {
      fc.assert(
        fc.property(fenceTextArb, currentContentArb, rawSelectionArb, (fenceText, currentContent, selection) => {
          const plan = planEditModeMultilinePaste(fenceText, currentContent, selection)
          const freshParsed = parseMarkdownToBlocks(fenceText)

          // Sanity on the generator: no prelude/postlude → single root.
          expect(freshParsed).toHaveLength(1)
          expect(freshParsed[0].content).toContain('\n')

          expect(plan).not.toBeNull()
          if (!plan) return
          expect(plan.absorbedRoot ? plan.targetContent : plan.parsed[0].content).toContain(freshParsed[0].content)
        }),
        fuzzParams(80),
      )
    })
  })
})

// ──── pasteChordIntent ────

describe('pasteChordIntent: classifier totality', () => {
  const keyEventArb = fc.record({
    metaKey: fc.boolean(),
    ctrlKey: fc.boolean(),
    altKey: fc.boolean(),
    shiftKey: fc.boolean(),
    key: fc.oneof(fc.constantFrom('v', 'V', 'c', 'Enter', ' ', 'Meta'), fc.string({maxLength: 5})),
  })

  it("always returns 'split' | 'single-block' | null, never throws", () => {
    fc.assert(
      fc.property(keyEventArb, event => {
        const result = pasteChordIntent(event)
        expect(result === 'split' || result === 'single-block' || result === null).toBe(true)
      }),
      fuzzParams(100),
    )
  })
})
