// @vitest-environment node
/**
 * Fuzz suite for `matchCharTrigger` (src/editor/triggerMatch.ts). See
 * `src/test/fuzz.ts` for smoke/deep tier mechanics and `docs/fuzzing.md`
 * for conventions.
 *
 * ──── Contract, grounded at the call sites ────
 *
 * `matchCharTrigger` (triggerMatch.ts:73-133) is the ONE shared
 * backward-walk implementation behind two thin per-char wrappers:
 * `matchAtTrigger` (src/plugins/geo/placeAutocomplete.ts:121-122, no
 * extra opts) and `matchHashTrigger`
 * (src/plugins/supertags/typeAutocomplete.ts:78-79,
 * `{rejectDoubledTrigger: true}`). Both wrappers feed it a single line's
 * text plus an in-line cursor position, exactly as generated below (no
 * `\n` in the generated text, so `text`/`pos` here stand in for a
 * completion source's `lineText`/`linePos`).
 *
 * The module's own docblock states the ownership invariant this suite
 * differentials against (triggerMatch.ts:14-16): "spans owned by other
 * autocompletes — unclosed `[[` wikilinks and `((` blockrefs — never
 * fire a char trigger." The `TRIGGER_CHARS` comment (triggerMatch.ts:34-39)
 * is the sibling half of the same ownership story (trigger-vs-trigger,
 * not trigger-vs-bracket-span) and isn't independently re-tested here —
 * `triggerMatch.test.ts` already pins the "nearest trigger wins" example
 * cases; this suite's differential is the bracket-span half.
 *
 * `matchCharTrigger` claims to implement that wikilink half via
 * `isInsideUnclosedWikilink` (triggerMatch.ts:52-68) and the blockref
 * half via a same-shape regex the docblock says "mirrors
 * blockrefAutocomplete's own matcher exactly"
 * (triggerMatch.ts:125-129). Property B below checks that claim against
 * the ACTUAL sibling regexes rather than trusting the docblock:
 *   - `backlinkCompletionSource`'s open-bracket match,
 *     src/utils/backlinkAutocomplete.ts:56: `/\[\[([^\]]*?)$/` against
 *     `beforeCursor = lineText.slice(0, linePos)`.
 *   - `blockrefCompletionSource`'s open-paren match,
 *     src/utils/blockrefAutocomplete.ts:38: `/\(\(([^)]*?)$/`, same
 *     shape.
 * Both regexes are anchored at `$` (end of `beforeCursor`), so when they
 * match, the span they claim is `[match.index, pos)` — the sibling
 * source considers every position in that span part of an unclosed
 * bracket sequence it owns.
 *
 * ──── KNOWN LEAD, hand-confirmed against the real module before writing
 * this file (see scratch notes) ────
 *
 * `text = ']] [[ #tag'`, `pos = 10`, `trigger = '#'`:
 * `matchCharTrigger` returns `{from: 6, query: 'tag'}`, but
 * `beforeCursor.match(/\[\[([^\]]*?)$/)` matches at index 3 (the second
 * `[[`), claiming span `[3, 10)` — which contains `from = 6`. Root
 * cause: `isInsideUnclosedWikilink` (triggerMatch.ts:55-68) counts `[[`
 * and `]]` occurrences as a flat pair-count (`opens > closes`) rather
 * than tracking whether the LAST bracket pair before `triggerPos` is an
 * unmatched open. The leading, unmatched `]]` here increments `closes`
 * and cancels out the LATER, also-unmatched `[[` in the count, so
 * `opens (1) > closes (1)` is false even though position 6 sits inside
 * a genuinely-unclosed `[[` span. This is a real product bug (the
 * module's own stated invariant, triggerMatch.ts:14-16, disagrees with
 * the code) — production code is NOT touched here per fuzzing.md's
 * oracle discipline; the suite is expected to fail on it and the
 * failure is reported prominently rather than weakened away.
 *
 * ──── Generators ────
 *
 * Text is drawn from a small alphabet biased toward the exact
 * structural characters both `matchCharTrigger` and the sibling regexes
 * key off (`[`, `]`, `(`, `)`, `#`, `@`, space, tab, plus a couple of
 * plain letters) so bracket-salad shapes like the KNOWN LEAD case are
 * common, not needles in a haystack of prose. The known counterexample
 * itself is mixed in directly (small weight) so the fixed smoke seed
 * reliably explores it without relying on a random draw to land on it.
 */
import { describe, expect, it } from 'vitest'
import fc from 'fast-check'
import { fuzzParams, fuzzTestTimeout } from '@/test/fuzz'
import { matchCharTrigger, type CharTriggerOptions } from '../triggerMatch'

const STRUCTURAL_CHARS = ['[', ']', '(', ')', '#', '@', ' ', '\t', 'a', 'b'] as const

const randomTextArb: fc.Arbitrary<string> = fc
  .array(fc.constantFrom(...STRUCTURAL_CHARS), {minLength: 0, maxLength: 30})
  .map(chars => chars.join(''))

interface Case {
  text: string
  pos: number
}

const randomCaseArb: fc.Arbitrary<Case> = randomTextArb.chain(text =>
  fc.record({text: fc.constant(text), pos: fc.integer({min: 0, max: text.length})}),
)

/** The hand-confirmed KNOWN LEAD counterexample (see docblock above),
 *  mixed into the generator with nonzero weight so the fixed smoke seed
 *  reliably reaches it rather than depending on a random draw. */
const knownLeadCaseArb: fc.Arbitrary<Case> = fc.constant({text: ']] [[ #tag', pos: 10})

const caseArb: fc.Arbitrary<Case> = fc.oneof(
  {weight: 2, arbitrary: knownLeadCaseArb},
  {weight: 8, arbitrary: randomCaseArb},
)

const triggerArb: fc.Arbitrary<'@' | '#'> = fc.constantFrom('@', '#')

/** Mirrors the real wrappers' fixed opts per trigger
 *  (placeAutocomplete.ts:121-122, typeAutocomplete.ts:78-79) rather than
 *  fuzzing `opts` independently — the property is about span ownership,
 *  which is orthogonal to `rejectDoubledTrigger`, and this keeps the
 *  suite differentialing against what production code actually calls. */
const optsFor = (trigger: '@' | '#'): CharTriggerOptions =>
  trigger === '#' ? {rejectDoubledTrigger: true} : {}

describe('matchCharTrigger', () => {
  it('never throws for a registered trigger, and a non-null result is self-consistent (triggerMatch.ts:73-133)', () => {
    fc.assert(
      fc.property(caseArb, triggerArb, ({text, pos}, trigger) => {
        const result = matchCharTrigger(text, pos, trigger, optsFor(trigger))
        if (result === null) return
        // `from` is the trigger char's own position, strictly before
        // `pos` (triggerMatch.ts:19-21, 115).
        expect(result.from).toBeGreaterThanOrEqual(0)
        expect(result.from).toBeLessThan(pos)
        expect(text[result.from]).toBe(trigger)
        // `query = text.slice(i, pos)` where `i = from + 1`
        // (triggerMatch.ts:110).
        expect(result.query).toBe(text.slice(result.from + 1, pos))
      }),
      fuzzParams(300),
    )
  }, fuzzTestTimeout())

  it('a match never falls inside a span backlinkAutocomplete or blockrefAutocomplete claims as an unclosed bracket sequence (triggerMatch.ts:14-16 ownership invariant, differentialed against backlinkAutocomplete.ts:56 and blockrefAutocomplete.ts:38)', () => {
    fc.assert(
      fc.property(caseArb, triggerArb, ({text, pos}, trigger) => {
        const result = matchCharTrigger(text, pos, trigger, optsFor(trigger))
        if (result === null) return

        // Both completion sources compute this exact slice from their
        // CodeMirror line/pos before matching
        // (backlinkAutocomplete.ts:52, blockrefAutocomplete.ts:32).
        const beforeCursor = text.slice(0, pos)

        // backlinkAutocomplete.ts:56 — matches iff `beforeCursor` ends
        // in an unclosed `[[...`; when it does, span `[index, pos)` is
        // wikilink-owned.
        const backlinkMatch = beforeCursor.match(/\[\[([^\]]*?)$/)
        if (backlinkMatch) {
          const spanStart = backlinkMatch.index!
          const insideBacklinkSpan = result.from >= spanStart && result.from < pos
          expect(insideBacklinkSpan).toBe(false)
        }

        // blockrefAutocomplete.ts:38 — matches iff `beforeCursor` ends
        // in an unclosed `((...`; when it does, span `[index, pos)` is
        // blockref-owned.
        const blockrefMatch = beforeCursor.match(/\(\(([^)]*?)$/)
        if (blockrefMatch) {
          const spanStart = blockrefMatch.index!
          const insideBlockrefSpan = result.from >= spanStart && result.from < pos
          expect(insideBlockrefSpan).toBe(false)
        }
      }),
      fuzzParams(300),
    )
  }, fuzzTestTimeout())
})
