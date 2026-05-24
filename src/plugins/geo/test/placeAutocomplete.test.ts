import { describe, expect, it } from 'vitest'
import { matchAtTrigger } from '../placeAutocomplete'

describe('matchAtTrigger', () => {
  it('matches @ at start of line', () => {
    const m = matchAtTrigger('@dandelion', 10)
    expect(m).toEqual({from: 0, query: 'dandelion'})
  })

  it('matches @ after whitespace', () => {
    const m = matchAtTrigger('met at @blue', 12)
    expect(m).toEqual({from: 7, query: 'blue'})
  })

  it('matches @ with an empty query (right after the @)', () => {
    const m = matchAtTrigger('met at @', 8)
    expect(m).toEqual({from: 7, query: ''})
  })

  it('does NOT match inside an email-like sequence', () => {
    expect(matchAtTrigger('a@b', 3)).toBeNull()
    expect(matchAtTrigger('user@example', 12)).toBeNull()
  })

  it('does NOT match inside [[wikilink]] brackets', () => {
    expect(matchAtTrigger('[[@foo', 6)).toBeNull()
    expect(matchAtTrigger('[[foo @bar', 10)).toBeNull()
  })

  it('does NOT match when there is no @ in the current token', () => {
    expect(matchAtTrigger('dandelion', 9)).toBeNull()
    expect(matchAtTrigger('hello world', 11)).toBeNull()
  })

  it('matches multi-word queries up to the cursor', () => {
    const m = matchAtTrigger('lunch @blue bottle', 11)
    expect(m).toEqual({from: 6, query: 'blue'})
  })
})
