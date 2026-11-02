import { describe, expect, it } from 'vitest'
import { countCharacters, countWords } from '../textCounts'

describe('countWords', () => {
  it('counts whitespace-separated tokens', () => {
    expect(countWords('')).toBe(0)
    expect(countWords('   ')).toBe(0)
    expect(countWords('one')).toBe(1)
    expect(countWords('  two   words\n\tand three ')).toBe(4)
  })

  it('skips tokens with no letter or digit (markdown markers, dashes)', () => {
    expect(countWords('- [ ] a — b **')).toBe(2)
    expect(countWords('# Heading')).toBe(1)
  })

  it('keeps markdown-wrapped words and links as one token each', () => {
    expect(countWords('**bold** [[Page name]] https://example.com/x')).toBe(4)
    expect(countWords("don't 2026-11-02")).toBe(2)
  })

  it('counts letters outside ASCII', () => {
    expect(countWords('привіт світ café')).toBe(3)
  })
})

describe('countCharacters', () => {
  it('is the raw content length', () => {
    expect(countCharacters('')).toBe(0)
    expect(countCharacters('a b')).toBe(3)
  })
})
