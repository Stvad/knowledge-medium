import { CompletionContext } from '@codemirror/autocomplete'
import { EditorState } from '@codemirror/state'
import { describe, expect, it } from 'vitest'
import {
  matchAtTrigger,
  placeCompletionSource,
  type PlaceAutocompleteCandidate,
} from '../placeAutocomplete'

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

describe('placeCompletionSource', () => {
  const docContext = (doc: string, pos: number): CompletionContext => {
    const state = EditorState.create({doc})
    return new CompletionContext(state, pos, true)
  }

  it('returns pending candidates and bypasses trigger detection', async () => {
    const pendingCandidates: PlaceAutocompleteCandidate[] = [
      {id: 'a', source: 'google', label: 'Cafe A', insertText: 'Cafe A'},
      {id: 'b', source: 'drop-pin', label: 'Drop pin', insertText: '', coords: {lat: 1, lng: 2}},
    ]
    let consumed = false
    const source = placeCompletionSource({
      getCandidates: async () => [],
      resolvePlace: async () => null,
      consumePendingCandidates: () => {
        if (consumed) return null
        consumed = true
        return {span: {from: 0, to: 3}, candidates: pendingCandidates}
      },
    })

    // Doc has no `@` — without pending, this would return null.
    const result = await source(docContext('foo', 3))
    expect(result).not.toBeNull()
    expect(result!.from).toBe(0)
    expect(result!.to).toBe(3)
    expect(result!.options).toHaveLength(2)
    expect(result!.options[0]).toMatchObject({label: 'Cafe A'})
    expect(result!.options[1]).toMatchObject({label: 'Drop pin'})
  })

  it('drains the pending picker on the first call, then falls back to trigger flow', async () => {
    const pending: PlaceAutocompleteCandidate[] = [
      {id: 'a', source: 'google', label: 'X', insertText: 'X'},
    ]
    let consumed = false
    const trigger: PlaceAutocompleteCandidate[] = [
      {id: 't', source: 'local', label: 'Local', insertText: 'Local'},
    ]
    const source = placeCompletionSource({
      getCandidates: async () => trigger,
      resolvePlace: async () => null,
      consumePendingCandidates: () => {
        if (consumed) return null
        consumed = true
        return {span: {from: 0, to: 0}, candidates: pending}
      },
    })

    const first = await source(docContext('@here', 5))
    expect(first!.options.map(o => o.label)).toEqual(['X'])

    const second = await source(docContext('@here', 5))
    expect(second!.options.map(o => o.label)).toEqual(['Local'])
  })

  it('without consumePendingCandidates, falls back to normal trigger flow', async () => {
    const source = placeCompletionSource({
      getCandidates: async () => [
        {id: 't', source: 'local', label: 'Local', insertText: 'Local'},
      ],
      resolvePlace: async () => null,
    })
    const result = await source(docContext('@', 1))
    expect(result!.options.map(o => o.label)).toEqual(['Local'])
  })
})
