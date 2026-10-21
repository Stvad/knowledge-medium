import { describe, expect, it } from 'vitest'
import { hasLoneSurrogate, truncate, truncateMiddle } from '@/utils/string.js'

/** Matches a surrogate code unit standing on its own — the artefact of
 *  cutting a string mid-character, which renders as `�`. */

describe('truncation is character-safe', () => {
  // Each of these is a surrogate PAIR in UTF-16, so any cut made by
  // `.length` arithmetic lands mid-character roughly half the time.
  const emoji = '🎉'.repeat(30)
  /** 13 emoji: 26 UTF-16 units but only 13 characters. */
  const shortEmoji = '🎉'.repeat(13)

  it('truncate does not split a character at the cut', () => {
    const result = truncate(emoji, 24)

    expect(hasLoneSurrogate(result)).toBe(false)
    expect(result.endsWith('…')).toBe(true)
  })

  it('truncateMiddle does not split a character at EITHER cut', () => {
    const result = truncateMiddle(emoji, 24)

    expect(hasLoneSurrogate(result)).toBe(false)
    expect(result).toContain('…')
  })

  it('measures the budget in characters, not UTF-16 units', () => {
    // 13 emoji are 26 code units but 13 characters, so a 24-char budget
    // fits them whole — cutting here would be measuring the wrong thing.
    expect(truncate(shortEmoji, 24)).toBe(shortEmoji)
    expect(truncateMiddle(shortEmoji, 24)).toBe(shortEmoji)
  })

  it('leaves ordinary text exactly as before', () => {
    expect(truncate('short', 24)).toBe('short')
    expect(truncate('A'.repeat(30), 24)).toBe(`${'A'.repeat(23)}…`)
    expect(truncateMiddle('Quarterly Planning Meeting Notes 2026', 24))
      .toBe('Quarterly Pl… Notes 2026')
  })
})
