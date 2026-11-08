// @vitest-environment node
/**
 * Fuzz suite for the inline-date rewrite behind rescheduling a block by its
 * `[[date]]` reference (`replaceSingleDateReferenceContent`) — see
 * `src/test/fuzz.ts` for the smoke/deep tier mechanics.
 *
 * The rewrite edits the user's own content, so the oracles are about what it
 * must NOT touch:
 *
 *  - a block built as `prefix [[date]] suffix`, with bracket-free text around
 *    the date, comes back as exactly `prefix [[new date]] suffix`, in the
 *    style (ISO or long form) the old date was written in;
 *  - two date references are ambiguous, so the content is left alone;
 *  - on arbitrary bracket soup, a rewrite that happens changes only the span
 *    of one date reference, the result reads back as the requested day, and
 *    rewriting again to the same day changes nothing.
 */
import { describe, expect, it } from 'vitest'
import fc from 'fast-check'
import { fuzzParams, fuzzTestTimeout } from '@/test/fuzz'
import { formatIsoDate, formatRoamDate } from '@/utils/dailyPage'
import { replaceSingleDateReferenceContent, singleDateReferenceMatch } from '../referenceDateAdapter'

/** A calendar day as local `Date` parts, so the oracle never crosses a
 *  timezone. Years from 1971: both forms render four-digit years there. */
const dayArb = fc
  .record({year: fc.integer({min: 1971, max: 2099}), month: fc.integer({min: 1, max: 12}), day: fc.integer({min: 1, max: 31})})
  .map(({year, month, day}) => new Date(year, month - 1, Math.min(day, new Date(year, month, 0).getDate())))

const styleArb = fc.constantFrom<'iso' | 'long'>('iso', 'long')
const render = (date: Date, style: 'iso' | 'long'): string =>
  style === 'iso' ? formatIsoDate(date) : formatRoamDate(date)

/** Prose that cannot open or close a wikilink. */
const plainArb = fc.string({
  unit: fc.constantFrom(...'abc XYZ019,.;:-#()!?\'"`*_/\\\n\t'),
  maxLength: 30,
})

/** Bracket soup with real date references mixed in. */
const soupArb = fc
  .array(
    fc.oneof(
      {weight: 3, arbitrary: plainArb},
      {weight: 3, arbitrary: fc.constantFrom('[[', ']]', '[', ']', '#[[', '((', '))', ' ')},
      {weight: 2, arbitrary: fc.tuple(dayArb, styleArb).map(([date, style]) => `[[${render(date, style)}]]`)},
      {weight: 1, arbitrary: fc.tuple(dayArb, styleArb).map(([date, style]) => render(date, style))},
    ),
    {maxLength: 10},
  )
  .map(parts => parts.join(''))

describe('replaceSingleDateReferenceContent', () => {
  it('rewrites only the one date reference, in the style it was written', () => {
    fc.assert(
      fc.property(plainArb, plainArb, dayArb, dayArb, styleArb, (prefix, suffix, from, to, style) => {
        const content = `${prefix}[[${render(from, style)}]]${suffix}`
        expect(replaceSingleDateReferenceContent(content, formatIsoDate(to)))
          .toBe(`${prefix}[[${render(to, style)}]]${suffix}`)
      }),
      fuzzParams(200),
    )
  }, fuzzTestTimeout())

  it('leaves content with two date references alone', () => {
    fc.assert(
      fc.property(plainArb, plainArb, plainArb, dayArb, dayArb, dayArb, styleArb, styleArb,
        (a, b, c, first, second, to, firstStyle, secondStyle) => {
          const content = `${a}[[${render(first, firstStyle)}]]${b}[[${render(second, secondStyle)}]]${c}`
          expect(replaceSingleDateReferenceContent(content, formatIsoDate(to))).toBeNull()
        }),
      fuzzParams(150),
    )
  }, fuzzTestTimeout())

  it('on any content, touches nothing outside one date reference and reads back as the new day', () => {
    fc.assert(
      fc.property(soupArb, dayArb, (content, to) => {
        const iso = formatIsoDate(to)
        const next = replaceSingleDateReferenceContent(content, iso)
        if (next === null) return
        const before = singleDateReferenceMatch(content)!
        const head = content.slice(0, before.ref.startIndex)
        const tail = content.slice(before.ref.endIndex)
        expect(next.startsWith(head)).toBe(true)
        expect(next.endsWith(tail)).toBe(true)
        expect(next.length).toBeGreaterThanOrEqual(head.length + tail.length)
        const after = singleDateReferenceMatch(next)
        expect(after?.iso).toBe(iso)
        expect(after?.style).toBe(before.style)
        expect(after?.ref.startIndex).toBe(before.ref.startIndex)
        // Idempotent: the day is already there.
        expect(replaceSingleDateReferenceContent(next, iso)).toBe(next)
      }),
      fuzzParams(200),
    )
  }, fuzzTestTimeout())
})
