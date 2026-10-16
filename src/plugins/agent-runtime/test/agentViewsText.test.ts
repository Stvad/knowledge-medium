import { describe, expect, it } from 'vitest'
import { hasLoneSurrogate } from '@/utils/string'
import { snippet } from '../agentViews/text'

describe('snippet', () => {
  it('never cuts an astral character in half, whichever side of a pair its boundaries land on', () => {
    const content = `${'\u{1F600}'.repeat(100)} needle ${'\u{1F600}'.repeat(100)}`
    // Odd and even widths put each boundary on both halves of a pair.
    for (const width of [139, 140, 141, 142]) {
      const out = snippet(content, 'needle', width)
      expect(out).toContain('needle')
      expect(hasLoneSurrogate(out)).toBe(false)
    }
  })
})

describe('snippet anchoring', () => {
  it('never centers on a word from an excluded phrase', () => {
    const content = `enormousword ${'filler '.repeat(40)} the cat sat`
    expect(snippet(content, 'cat -"one enormousword three"')).toContain('cat sat')
    expect(snippet(content, 'cat NOT enormousword')).toContain('cat sat')
  })
})
