// @vitest-environment happy-dom
import { CompletionContext } from '@codemirror/autocomplete'
import { markdown, markdownLanguage } from '@codemirror/lang-markdown'
import { EditorState } from '@codemirror/state'
import { EditorView } from '@codemirror/view'
import { describe, expect, it, vi } from 'vitest'
import {
  matchAtTrigger,
  placeCompletionSource,
  type PlaceAutocompleteCandidate,
} from '../placeAutocomplete'

describe('matchAtTrigger', () => {
  // Char-generic matcher behavior (whitespace, caps, wikilink guards,
  // email/anchor rejection) is covered in
  // src/editor/test/triggerMatch.test.ts against the shared
  // matchCharTrigger; this suite pins only the @-wrapper wiring.
  it('matches a basic place query', () => {
    expect(matchAtTrigger('met at @blue bottle', 19)).toEqual({from: 7, query: 'blue bottle'})
  })

  it('still matches a doubled @ (no stacked-trigger rejection for @)', () => {
    expect(matchAtTrigger('@@name', 6)).toEqual({from: 1, query: 'name'})
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
      deliverInsert: async () => {},
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
      deliverInsert: async () => {},
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
      deliverInsert: async () => {},
    })
    const result = await source(docContext('@', 1))
    expect(result!.options.map(o => o.label)).toEqual(['Local'])
  })

  it('never fires inside literal markdown (code), where @word is the code', async () => {
    const source = placeCompletionSource({
      getCandidates: async () => [
        {id: 't', source: 'local', label: 'Local', insertText: 'Local'},
      ],
      resolvePlace: async () => null,
      deliverInsert: async () => {},
    })
    const markdownContext = (doc: string, pos: number): CompletionContext =>
      new CompletionContext(
        EditorState.create({doc, extensions: [markdown({base: markdownLanguage})]}),
        pos,
        false,
      )
    const fenced = '```\n@Injectable()\n```'
    expect(await source(markdownContext(fenced, fenced.indexOf('()')))).toBeNull()
    const inline = 'use `@media` here'
    expect(await source(markdownContext(inline, inline.indexOf('`', 5)))).toBeNull()
    // …but prose in the same language still fires.
    const prose = 'met at @blue'
    expect(await source(markdownContext(prose, prose.length))).not.toBeNull()
  })
})

describe('placeCompletionSource — resolved insert delivery', () => {
  it('hands the wikilink, the trigger text and its span to deliverInsert', async () => {
    const delivered: Array<{span: {from: number; to: number}; triggerText: string; insert: string}> = []
    const source = placeCompletionSource({
      getCandidates: async () => [
        {id: 'g', source: 'google', label: 'Blue Bottle', insertText: 'Blue Bottle'},
      ],
      resolvePlace: async () => ({kind: 'insert', name: 'Blue Bottle'}),
      deliverInsert: async args => { delivered.push(args) },
    })
    const state = EditorState.create({doc: 'met at @blue'})
    const result = await source(new CompletionContext(state, 12, true))
    const option = result!.options[0]
    if (typeof option.apply !== 'function') throw new Error('expected a function apply')
    const view = new EditorView({state, parent: document.body})
    try {
      option.apply(view, option, 7, 12)
      await vi.waitFor(() => {
        expect(delivered).toEqual([{span: {from: 7, to: 12}, triggerText: '@blue', insert: '[[Blue Bottle]]'}])
      })
    } finally {
      view.destroy()
    }
  })
})
