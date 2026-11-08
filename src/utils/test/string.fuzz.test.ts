// @vitest-environment node
/**
 * Fuzz suite for the one-line preview helpers in `src/utils/string.ts`, over
 * strings that mix whole code points (astral included) with lone UTF-16 code
 * units, and are biased toward the whitespace and line breaks the helpers
 * act on.
 *
 * Oracles, each written from the helper's docblock rather than its body:
 * - `hasLoneSurrogate` equals a code-unit scan: a high surrogate not followed
 *   by a low one, or a low one not preceded by a high one.
 * - `truncate` / `truncateMiddle`: within `max` code points; unchanged when
 *   the value fits; otherwise a code-point prefix (and, for the middle form,
 *   suffix) around one `…`, the head no shorter than the tail; and a
 *   well-formed value stays well-formed (no cut lands inside a pair).
 *   `max` starts at 1, what every caller passes: at 0 neither helper can
 *   return a value within its budget, since both always return at least `…`.
 * - `firstLine` is the value's longest prefix with no CR or LF.
 * - `collapseWhitespace` keeps the words and their order, and is idempotent.
 */
import { describe, expect, it } from 'vitest'
import fc from 'fast-check'
import { fuzzParams, fuzzTestTimeout } from '@/test/fuzz'
import { codePointUnitArb, utf16UnitArb } from '@/test/arbitraries/utf16'
import { collapseWhitespace, firstLine, hasLoneSurrogate, truncate, truncateMiddle } from '@/utils/string'

const breakArb = fc.constantFrom(' ', '\t', '\n', '\r', '\r\n', '\u00a0', '\u2028', '\u3000')

const unitArb = fc.oneof(
  {arbitrary: codePointUnitArb, weight: 4},
  {arbitrary: utf16UnitArb, weight: 1},
  {arbitrary: fc.constantFrom('a', 'Z', '😀', '\ud800', '\udc00'), weight: 2},
  {arbitrary: breakArb, weight: 2},
)
const valueArb = fc.array(unitArb, {maxLength: 24}).map(units => units.join(''))
const wellFormedArb = fc.string({unit: codePointUnitArb, maxLength: 24})
const maxArb = fc.integer({min: 1, max: 26})

/** The predicate, read off the UTF-16 definition one code unit at a time. */
const scanForLoneSurrogate = (value: string): boolean => {
  for (let i = 0; i < value.length; i++) {
    const unit = value.charCodeAt(i)
    const isHigh = unit >= 0xd800 && unit <= 0xdbff
    const isLow = unit >= 0xdc00 && unit <= 0xdfff
    if (isLow) return true
    if (isHigh) {
      const next = value.charCodeAt(i + 1)
      if (!(next >= 0xdc00 && next <= 0xdfff)) return true
      i++
    }
  }
  return false
}

const codePoints = (value: string): string[] => [...value]

describe('hasLoneSurrogate', () => {
  it('agrees with a code-unit scan', () => {
    fc.assert(
      fc.property(valueArb, value => {
        expect(hasLoneSurrogate(value)).toBe(scanForLoneSurrogate(value))
      }),
      fuzzParams(400),
    )
  }, fuzzTestTimeout())
})

describe('truncate', () => {
  it('stays within budget, keeps a prefix, and never splits a pair', () => {
    fc.assert(
      fc.property(fc.oneof(valueArb, wellFormedArb), maxArb, (value, max) => {
        const result = truncate(value, max)
        const chars = codePoints(value)
        expect(codePoints(result).length).toBeLessThanOrEqual(max)
        if (chars.length <= max) {
          expect(result).toBe(value)
          return
        }
        expect(result).toBe(chars.slice(0, max - 1).join('') + '…')
        if (!scanForLoneSurrogate(value)) expect(scanForLoneSurrogate(result)).toBe(false)
      }),
      fuzzParams(400),
    )
  }, fuzzTestTimeout())
})

describe('truncateMiddle', () => {
  it('stays within budget and keeps a head and a tail around one ellipsis', () => {
    fc.assert(
      fc.property(fc.oneof(valueArb, wellFormedArb), maxArb, (value, max) => {
        const result = truncateMiddle(value, max)
        const chars = codePoints(value)
        const out = codePoints(result)
        expect(out.length).toBeLessThanOrEqual(max)
        if (chars.length <= max) {
          expect(result).toBe(value)
          return
        }
        // Located by position, since the value may hold an ellipsis of its own.
        const at = Math.ceil((max - 1) / 2)
        expect(out[at]).toBe('…')
        const head = out.slice(0, at)
        const tail = out.slice(at + 1)
        expect(head.length + tail.length).toBe(max - 1)
        expect(head.length).toBeGreaterThanOrEqual(tail.length)
        expect(head).toEqual(chars.slice(0, head.length))
        expect(tail).toEqual(chars.slice(chars.length - tail.length))
        if (!scanForLoneSurrogate(value)) expect(scanForLoneSurrogate(result)).toBe(false)
      }),
      fuzzParams(400),
    )
  }, fuzzTestTimeout())
})

describe('firstLine', () => {
  it('is the longest prefix free of CR and LF', () => {
    fc.assert(
      fc.property(valueArb, value => {
        const line = firstLine(value)
        expect(value.startsWith(line)).toBe(true)
        expect(/[\r\n]/.test(line)).toBe(false)
        const rest = value.slice(line.length)
        expect(rest === '' || rest[0] === '\r' || rest[0] === '\n').toBe(true)
      }),
      fuzzParams(400),
    )
  }, fuzzTestTimeout())
})

describe('collapseWhitespace', () => {
  it('keeps the words in order, single-spaced, and is idempotent', () => {
    fc.assert(
      fc.property(valueArb, value => {
        const collapsed = collapseWhitespace(value)
        const words = value.split(/\s/).filter(word => word !== '')
        expect(collapsed).toBe(words.join(' '))
        expect(collapseWhitespace(collapsed)).toBe(collapsed)
      }),
      fuzzParams(400),
    )
  }, fuzzTestTimeout())
})
