import { describe, expect, it } from 'vitest'
import { NAMES_IN_A_SENTENCE, describeNames, firstFew } from './nameList'

const keys = (n: number) => Array.from({length: n}, (_, i) => `key-${i}`)

describe('naming a few members of a counted set', () => {
  it('counts the remainder off the set, not off the list it was handed', () => {
    // The reason this module exists. Lists reaching a sentence are capped by
    // whatever produced them, so a remainder taken from the array silently
    // under-reports by everything the cap dropped.
    expect(describeNames(keys(NAMES_IN_A_SENTENCE), 400)).toMatch(/and 397 more$/)
  })

  it('says nothing about a remainder when it has the whole set', () => {
    expect(describeNames(['a', 'b'])).toBe('"a", "b"')
  })

  it('quotes each name, so a name containing a comma is still one name', () => {
    expect(describeNames(['a, b'])).toBe('"a, b"')
  })

  it('does not report a negative remainder when the count lags the list', () => {
    // A count and a list read a moment apart can disagree; "and -1 more" in a
    // refusal toast is worse than saying nothing about the remainder.
    expect(firstFew(keys(2), 1).more).toBe(0)
  })
})
