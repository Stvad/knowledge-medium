// @vitest-environment node
/**
 * Fuzz suite for the pure paste planners in `src/paste/operations.ts` — see
 * `src/test/fuzz.ts` for the smoke/deep tier mechanics.
 *
 * Targets and their contracts:
 *
 * - `planSingleBlockPaste` (operations.ts:96-107): normalizes CRLF/CR to LF
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
 * - `planEditModeMultilinePaste` (operations.ts:251-284) is the converse: it
 *   DOES clamp (`:260-261`, `Math.max(0, Math.min(...))`), so its selection
 *   arbitrary deliberately includes out-of-range and unordered `{from, to}`
 *   (negative, past `currentContent.length`, `from > to`). Oracles, each
 *   cited at its assertion below:
 *     - never throws, and returns `null` exactly when the parsed paste has
 *       no root to absorb (`:256-258` — blank/whitespace-only paste).
 *     - `parsed` is the parser's full output, unfiltered, returned verbatim
 *       (`:256,276`) — content sequence conservation, checked against a
 *       fresh `parseMarkdownToBlocks` call. (ids/orderKeys are `uuidv4`/
 *       jittered-key random per call — see markdownParser.fuzz.test.ts's
 *       note on `fractional-indexing-jittered` — so only `content` is
 *       compared, never `id`/`orderKey`.)
 *     - effective from/to are clamped into `[0, currentContent.length]`.
 *     - `targetContent` always starts with `currentContent.slice(0,
 *       clampedFrom)` (`:262,273`: `prefix + mergedFirstContent` is always a
 *       leading segment of `targetContent`, in both branches of `:278-280`).
 *     - `suffix`/`targetContent`'s trailing segment reconstruct
 *       `currentContent.slice(clampedTo)` exactly, branching on
 *       `createsAdditionalBlocks` (`:264,278-283`) — which is equivalent to
 *       `parsed.length > 1` (every id is unique, so "some block other than
 *       the absorbed root" reduces to "more than one block total").
 *     - `focusOffsetInTarget` (`:273,281`) is always
 *       `contentBeforeStructuralBreak.length`; derived exactly per branch
 *       below, which also implies the weaker `[0, targetContent.length]`
 *       range the task asked for.
 *     - fenced-code root (`:265-272`): a multi-line absorbed root (only
 *       possible for a fence — the only parse that yields one block
 *       spanning newlines) is kept whole (`mergedFirstContent =
 *       absorbedRoot.content`), so `targetContent` contains the full fence
 *       body verbatim — checked directly with a fence-only generator.
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
 * - `pasteChordIntent` (operations.ts:76-83): totality only — classifies an
 *   arbitrary key-event-shaped record into `'split' | 'single-block' |
 *   null` and never throws.
 */
import { describe, it, expect } from 'vitest'
import fc from 'fast-check'
import { fuzzParams } from '@/test/fuzz'
import { lineFragmentArb } from '@/test/arbitraries/markdownSoup'
import { parseMarkdownToBlocks } from '@/utils/markdownParser'
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

        // operations.ts:100 — `\r\n?` replaced with `\n`, so no bare \r or
        // \r\n can survive into `insert`.
        expect(plan.insert).not.toMatch(/\r/)

        // operations.ts:103-104 — pass-through, unchanged.
        expect(plan.from).toBe(selection.from)
        expect(plan.to).toBe(selection.to)

        // operations.ts:105.
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
    'never throws; clamps from/to; reconstructs prefix/suffix exactly; conserves `parsed` content (operations.ts:251-284)',
    () => {
      fc.assert(
        fc.property(pastedTextArb, currentContentArb, rawSelectionArb, (pastedText, currentContent, selection) => {
          const plan = planEditModeMultilinePaste(pastedText, currentContent, selection)
          const freshParsed = parseMarkdownToBlocks(pastedText)

          if (freshParsed.length === 0) {
            // No root block to absorb (operations.ts:256-258).
            expect(plan).toBeNull()
            return
          }
          expect(plan).not.toBeNull()
          if (!plan) return

          // Conservation: `parsed` is the parser's full, unfiltered output
          // (operations.ts:256,276). ids/orderKeys are randomized per call
          // (uuidv4 / jittered keys), so compare content only.
          expect(plan.parsed.map(b => b.content)).toEqual(freshParsed.map(b => b.content))

          const clampedFrom = Math.max(0, Math.min(selection.from, currentContent.length))
          const clampedTo = Math.max(clampedFrom, Math.min(selection.to ?? selection.from, currentContent.length))
          expect(clampedFrom).toBeGreaterThanOrEqual(0)
          expect(clampedFrom).toBeLessThanOrEqual(currentContent.length)
          expect(clampedTo).toBeGreaterThanOrEqual(clampedFrom)
          expect(clampedTo).toBeLessThanOrEqual(currentContent.length)

          // targetContent always starts with the clamped prefix (operations.ts:262,273).
          const prefix = currentContent.slice(0, clampedFrom)
          expect(plan.targetContent.startsWith(prefix)).toBe(true)

          // `createsAdditionalBlocks` (operations.ts:264) reduces to
          // `parsed.length > 1`: every parsed id is unique, so "some block
          // other than the absorbed root" is exactly "more than one block".
          const createsAdditionalBlocks = freshParsed.length > 1
          const trueSuffix = currentContent.slice(clampedTo)

          // Suffix reconstruction, branch-exact (operations.ts:278-283).
          if (createsAdditionalBlocks) {
            expect(plan.suffix).toBe(trueSuffix)
          } else {
            expect(plan.suffix).toBe('')
            expect(plan.targetContent.endsWith(trueSuffix)).toBe(true)
          }

          // focusOffsetInTarget = contentBeforeStructuralBreak.length always
          // (operations.ts:273,281); branch-exact value, which implies the
          // [0, targetContent.length] range.
          expect(plan.focusOffsetInTarget).toBeGreaterThanOrEqual(0)
          expect(plan.focusOffsetInTarget).toBeLessThanOrEqual(plan.targetContent.length)
          if (createsAdditionalBlocks) {
            expect(plan.focusOffsetInTarget).toBe(plan.targetContent.length)
          } else {
            expect(plan.focusOffsetInTarget).toBe(plan.targetContent.length - trueSuffix.length)
          }
        }),
        fuzzParams(150),
      )
    },
  )

  describe('fenced-code absorbed root keeps the full body (operations.ts:265-272)', () => {
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

    it('targetContent contains the full fence body verbatim', () => {
      fc.assert(
        fc.property(fenceTextArb, currentContentArb, rawSelectionArb, (fenceText, currentContent, selection) => {
          const plan = planEditModeMultilinePaste(fenceText, currentContent, selection)
          const freshParsed = parseMarkdownToBlocks(fenceText)

          // Sanity on the generator: no prelude/postlude → single root.
          expect(freshParsed).toHaveLength(1)
          expect(freshParsed[0].content).toContain('\n')

          expect(plan).not.toBeNull()
          if (!plan) return
          expect(plan.targetContent).toContain(freshParsed[0].content)
        }),
        fuzzParams(80),
      )
    })
  })
})

// ──── pasteChordIntent ────

describe('pasteChordIntent: classifier totality (operations.ts:76-83)', () => {
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
