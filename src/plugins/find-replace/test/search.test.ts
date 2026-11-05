import { describe, expect, it } from 'vitest'
import {
  buildContentSearchMatch,
  caseFoldingCodePoints,
  caseInsensitiveVariants,
  findLiteralMatches,
  previewForMatch,
  replaceLiteralMatches,
} from '../search.ts'

const insensitive = {matchCase: false, wholeWord: false}

describe('find/replace literal matching', () => {
  it('matches case-insensitively by default', () => {
    expect(findLiteralMatches('Alpha alpha ALPHA', 'alpha', insensitive))
      .toEqual([
        {index: 0, length: 5},
        {index: 6, length: 5},
        {index: 12, length: 5},
      ])
  })

  it('can require matching case', () => {
    expect(findLiteralMatches('Alpha alpha ALPHA', 'alpha', {
      matchCase: true,
      wholeWord: false,
    })).toEqual([{index: 6, length: 5}])
  })

  it('can require whole-word boundaries', () => {
    expect(findLiteralMatches('task tasks pretask task_done task-done', 'task', {
      matchCase: false,
      wholeWord: true,
    })).toEqual([
      {index: 0, length: 4},
      {index: 29, length: 4},
    ])
  })

  it('splices a case-insensitive replacement at offsets into the original text', () => {
    // `İ` lowercases to two code units, so offsets read off a lowercased copy
    // land one character late for everything after it.
    expect(replaceLiteralMatches('İstanbul foo bar', 'foo', 'X', insensitive)).toEqual({
      content: 'İstanbul X bar',
      replacementCount: 1,
    })
    // ...and the `i` inside that expansion is not a character of the original.
    expect(replaceLiteralMatches('xİy', 'i', 'Z', insensitive)).toEqual({
      content: 'xİy',
      replacementCount: 0,
    })
  })

  it('still considers a whole-word candidate that overlaps a rejected one', () => {
    expect(findLiteralMatches('xa.a.a', 'a.a', {matchCase: false, wholeWord: true}))
      .toEqual([{index: 3, length: 3}])
  })

  // The matcher folds the Kelvin sign onto `k` and `ſ` onto `s`; a word
  // boundary that saw them as punctuation would let a replace cut into a word.
  it('keeps whole-word boundaries for letters in any script, case-folded ones included', () => {
    const wholeWord = {matchCase: false, wholeWord: true}
    expect(findLiteralMatches('foo\u212Abar', 'k', wholeWord)).toEqual([])
    expect(findLiteralMatches('foo\u017Fbar', 's', wholeWord)).toEqual([])
    expect(findLiteralMatches('café', 'caf', wholeWord)).toEqual([])
    expect(findLiteralMatches('a \u212A b', 'k', wholeWord)).toEqual([{index: 2, length: 1}])
    expect(findLiteralMatches('\u{1D400}x x', 'x', wholeWord)).toEqual([{index: 4, length: 1}])
  })

  it('replaces each literal match without treating the find text as regex', () => {
    expect(replaceLiteralMatches('a.b a?b a.b', 'a.b', 'x', insensitive)).toEqual({
      content: 'x a?b x',
      replacementCount: 2,
    })
  })
})

describe('previewForMatch', () => {
  it('returns the surrounding text verbatim when it fits inside the context window', () => {
    // 'world' at index 6; default context (48) covers the whole string, so no
    // ellipsis on either side.
    expect(previewForMatch('hello world', {index: 6, length: 5})).toBe('hello world')
  })

  it('windows long content and marks both truncated sides with ellipses', () => {
    const content = 'left padding here MATCH right padding here'
    const index = content.indexOf('MATCH')
    const preview = previewForMatch(content, {index, length: 5}, 4)
    expect(preview.startsWith('...')).toBe(true)
    expect(preview.endsWith('...')).toBe(true)
    expect(preview).toContain('MATCH')
  })

  it('collapses runs of whitespace so multi-line content previews on one line', () => {
    expect(previewForMatch('a\n\n  b  MATCH  c\t\td', {index: 8, length: 5}))
      .toBe('a b MATCH c d')
  })
})

describe('buildContentSearchMatch', () => {
  it('summarizes the first hit with the total match count and a preview', () => {
    const match = buildContentSearchMatch('b1', 'find me and me again', 'me', insensitive)
    expect(match).toEqual({
      blockId: 'b1',
      originalContent: 'find me and me again',
      matchCount: 2,
      preview: 'find me and me again',
    })
  })

  it('returns null when the query does not occur in the content', () => {
    expect(buildContentSearchMatch('b1', 'nothing here', 'zzz', insensitive)).toBeNull()
  })

  it('short-circuits an empty query to null (no match, no preview)', () => {
    expect(buildContentSearchMatch('b1', 'any content', '', insensitive)).toBeNull()
  })
})

describe('caseInsensitiveVariants', () => {
  const escapeClassMember = (char: string) => char.replace(/[-\\\]^[]/g, '\\$&')
  // Measured ~0.5s alone: two passes over every code point.
  it('leaves out no code point with a case-insensitive partner', () => {
    const candidates = new Set(caseFoldingCodePoints())
    const anyCandidate = new RegExp(`[${[...candidates].map(escapeClassMember).join('')}]`, 'iu')
    const partnered: string[] = []
    for (let codePoint = 0; codePoint <= 0x10ffff; codePoint++) {
      if (codePoint >= 0xd800 && codePoint <= 0xdfff) continue
      const char = String.fromCodePoint(codePoint)
      if (!candidates.has(char) && anyCandidate.test(char)) partnered.push(char)
    }
    expect(partnered).toEqual([])
  }, 20_000)

  it('folds exactly U+017F and U+212A onto ASCII letters from outside ASCII', () => {
    const letters = 'abcdefghijklmnopqrstuvwxyz'
    const nonAscii = [...letters].flatMap(caseInsensitiveVariants).filter(char => char > '\x7f')
    expect(nonAscii.sort()).toEqual(['\u017F', '\u212A'])
  })

  it('returns the whole class of a code point, itself included', () => {
    expect(caseInsensitiveVariants('в').sort()).toEqual(['В', 'в', '\u1C80'].sort())
    expect(caseInsensitiveVariants('日')).toEqual(['日'])
  })
})
