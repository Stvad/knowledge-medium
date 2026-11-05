// @vitest-environment node
/**
 * Fuzz suite for the literal find/replace in `../search.ts`. See
 * `src/test/fuzz.ts` for smoke/deep tier mechanics and `docs/fuzzing.md` for
 * conventions. Pure and synchronous over strings: no DB, nothing to pin.
 *
 * Contract:
 *  - `findLiteralMatches` returns ascending, non-overlapping spans that are
 *    offsets into the ORIGINAL content: a replace splices at exactly those
 *    spans, so a span read off any transformed copy of the text mangles it.
 *  - Leftmost-first: every position is a candidate; an accepted match consumes
 *    its span, a candidate failing the whole-word boundary consumes nothing.
 *  - `replaceLiteralMatches` changes the content only inside those spans.
 *
 * Oracles, each independent of the regex the implementation uses:
 *  - an ASCII-folding scanner over an alphabet whose only case pairs are ASCII
 *    letters (the non-ASCII members have no partner in it), giving the exact
 *    expected span list, with and without whole-word;
 *  - a planted occurrence fenced by `\n` (which folds to nothing else) must be
 *    reported at its planted offset whatever precedes it — including text whose
 *    lowercase form is longer than itself;
 *  - every case-insensitive match equals the needle after a lower-upper-lower
 *    round trip through the string case mappings (which folds `ſ` to `s` and
 *    `ς` to `σ`, as case folding does), and every case-sensitive one is
 *    byte-equal.
 */
import fc from 'fast-check'
import { describe, expect, it } from 'vitest'
import { findLiteralMatches, replaceLiteralMatches } from '../search.ts'
import type { FindReplaceOptions } from '../types.ts'
import { fuzzParams } from '@/test/fuzz'

/** Case pairs only among the ASCII letters; every other member matches only
 *  itself under any case folding. `İ` is the one whose lowercase is longer. */
const ORACLE_ALPHABET = ['a', 'A', 'b', 'B', '_', '1', ' ', '.', '-', '*', '(', '\n', 'İ', 'ß', 'é', '😀']

/** Members with case relations that reach beyond ASCII. */
const TRICKY_ALPHABET = [
  ...ORACLE_ALPHABET,
  'i', 'I', 'ı', 's', 'S', 'ſ', 'k', 'K', 'K', 'ẞ', 'Σ', 'σ', 'ς', 'É', 'é', 'ﬀ',
]

const textOf = (alphabet: string[], minLength: number, maxLength: number) =>
  fc.array(fc.constantFrom(...alphabet), {minLength, maxLength}).map(parts => parts.join(''))

const optionsArb: fc.Arbitrary<FindReplaceOptions> =
  fc.record({matchCase: fc.boolean(), wholeWord: fc.boolean()})

const isAsciiLetter = (c: string): boolean => /^[A-Za-z]$/.test(c)
const isWordChar = (c: string | undefined): boolean => c !== undefined && /^[A-Za-z0-9_]$/.test(c)

const unitsEqual = (a: string, b: string, matchCase: boolean): boolean =>
  a === b || (!matchCase && isAsciiLetter(a) && isAsciiLetter(b) && a.toLowerCase() === b.toLowerCase())

const oracleMatches = (content: string, needle: string, options: FindReplaceOptions) => {
  const out: Array<{index: number; length: number}> = []
  if (needle.length === 0) return out
  let i = 0
  while (i + needle.length <= content.length) {
    let hit = true
    for (let j = 0; j < needle.length && hit; j++) hit = unitsEqual(content[i + j], needle[j], options.matchCase)
    const end = i + needle.length
    const bounded = !options.wholeWord || (
      (!isWordChar(content[i]) || !isWordChar(content[i - 1]))
      && (!isWordChar(content[end - 1]) || !isWordChar(content[end]))
    )
    if (hit && bounded) {
      out.push({index: i, length: needle.length})
      i = end
    } else {
      i += 1
    }
  }
  return out
}

const spliced = (content: string, spans: Array<{index: number; length: number}>, replace: string) => {
  let out = ''
  let cursor = 0
  for (const {index, length} of spans) {
    out += content.slice(cursor, index) + replace
    cursor = index + length
  }
  return out + content.slice(cursor)
}

const caseFolded = (text: string): string => text.toLowerCase().toUpperCase().toLowerCase()

describe('find/replace literal matching (fuzz)', () => {
  it('reports exactly the spans an ASCII-folding scanner finds', () => {
    fc.assert(
      fc.property(
        textOf(ORACLE_ALPHABET, 0, 30),
        textOf(ORACLE_ALPHABET, 1, 4),
        optionsArb,
        (content, needle, options) => {
          expect(findLiteralMatches(content, needle, options))
            .toEqual(oracleMatches(content, needle, options))
        },
      ),
      fuzzParams(400),
    )
  })

  it('reports a fenced occurrence at its planted offset, whatever precedes it', () => {
    fc.assert(
      fc.property(
        textOf(TRICKY_ALPHABET, 0, 20),
        textOf(TRICKY_ALPHABET.filter(c => c !== '\n'), 1, 4),
        textOf(TRICKY_ALPHABET, 0, 20),
        fc.boolean(),
        fc.string({maxLength: 3}),
        (before, needle, after, matchCase, replace) => {
          const options = {matchCase, wholeWord: false}
          const content = `${before}\n${needle}\n${after}`
          const planted = {index: before.length + 1, length: needle.length}

          expect(findLiteralMatches(content, needle, options)).toContainEqual(planted)
          const {content: next} = replaceLiteralMatches(content, needle, replace, options)
          expect(next).toContain(`\n${replace}\n`)
        },
      ),
      fuzzParams(400),
    )
  })

  it('matches only text equal to the needle, and replaces only inside the matches', () => {
    fc.assert(
      fc.property(
        textOf(TRICKY_ALPHABET, 0, 30),
        textOf(TRICKY_ALPHABET, 1, 3),
        optionsArb,
        fc.string({maxLength: 3}),
        (content, needle, options, replace) => {
          const spans = findLiteralMatches(content, needle, options)
          let cursor = 0
          for (const {index, length} of spans) {
            expect(index).toBeGreaterThanOrEqual(cursor)
            expect(length).toBeGreaterThan(0)
            const text = content.slice(index, index + length)
            if (options.matchCase) expect(text).toBe(needle)
            else expect(caseFolded(text)).toBe(caseFolded(needle))
            cursor = index + length
          }
          expect(cursor).toBeLessThanOrEqual(content.length)

          expect(replaceLiteralMatches(content, needle, replace, options)).toEqual({
            content: spliced(content, spans, replace),
            replacementCount: spans.length,
          })
        },
      ),
      fuzzParams(400),
    )
  })
})
