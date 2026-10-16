import { describe, expect, it } from 'vitest'
import { hasLoneSurrogate } from '@/utils/string'
import { snippet } from '../agentViews/text'

describe('snippet', () => {
  it('never cuts an astral character in half, whichever side of a pair its boundaries land on', () => {
    for (const lead of ['', 'x']) {
      for (const tail of ['', 'y']) {
        const content = `${lead}${'\u{1F600}'.repeat(100)} needle ${'\u{1F600}'.repeat(100)}${tail}`
        const out = snippet(content, 'needle')
        expect(out).toContain('needle')
        expect(hasLoneSurrogate(out)).toBe(false)
      }
    }
  })
})
