// @vitest-environment jsdom
import { CompletionContext } from '@codemirror/autocomplete'
import { EditorState } from '@codemirror/state'
import { EditorView } from '@codemirror/view'
import { describe, expect, it, vi } from 'vitest'
import {
  matchAtTrigger,
  placeCompletionSource,
  planResolvedInsert,
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

  it('matches multi-word queries up to a mid-word cursor', () => {
    const m = matchAtTrigger('lunch @blue bottle', 11)
    expect(m).toEqual({from: 6, query: 'blue'})
  })

  it('matches multi-word place names across single spaces', () => {
    const m = matchAtTrigger('lunch @blue bottle', 18)
    expect(m).toEqual({from: 6, query: 'blue bottle'})
  })

  it('keeps matching with a trailing space (mid-typing between words)', () => {
    const m = matchAtTrigger('@blue ', 6)
    expect(m).toEqual({from: 0, query: 'blue '})
  })

  it('does NOT match across a double space (query is over, prose resumed)', () => {
    expect(matchAtTrigger('@home  later that day', 21)).toBeNull()
  })

  it('does NOT match when the query starts with a space ("see you @ 5pm")', () => {
    expect(matchAtTrigger('see you @ 5pm', 13)).toBeNull()
  })

  it('does NOT match across tabs', () => {
    expect(matchAtTrigger('@foo\tbar', 8)).toBeNull()
  })

  it('does NOT match once the query exceeds the word cap', () => {
    expect(matchAtTrigger('@one two three four five six', 28))
      .toEqual({from: 0, query: 'one two three four five six'})
    expect(matchAtTrigger('@one two three four five six seven', 34)).toBeNull()
  })

  it('does NOT match once the query exceeds the length cap', () => {
    const long = `@${'a'.repeat(60)}`
    expect(matchAtTrigger(long, long.length)).toBeNull()
  })
})

describe('planResolvedInsert', () => {
  it('uses the recorded span when the trigger text is still there', () => {
    expect(planResolvedInsert('met at @blue', {from: 7, to: 12}, '@blue'))
      .toEqual({from: 7, to: 12})
  })

  it('re-locates the trigger text when the doc drifted around it', () => {
    // Text was prepended while the resolution was pending — the
    // recorded span no longer lines up.
    expect(planResolvedInsert('yesterday we met at @blue', {from: 7, to: 12}, '@blue'))
      .toEqual({from: 20, to: 25})
  })

  it('returns null when the trigger text is gone', () => {
    expect(planResolvedInsert('met at home', {from: 7, to: 12}, '@blue')).toBeNull()
  })

  it('returns null for an empty trigger', () => {
    expect(planResolvedInsert('met at @blue', {from: 7, to: 7}, '')).toBeNull()
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

describe('placeCompletionSource — resolved insert delivery', () => {
  const buildOption = async (opts: {
    resolveName: string
    persistInsert?: (args: {triggerText: string; insert: string}) => Promise<void>
  }) => {
    const source = placeCompletionSource({
      getCandidates: async () => [
        {id: 'g', source: 'google', label: 'Blue Bottle', insertText: 'Blue Bottle'},
      ],
      // Simulate a slow resolution (details fetch / collision toast).
      resolvePlace: async () => {
        await new Promise(r => setTimeout(r, 0))
        return {kind: 'insert', name: opts.resolveName}
      },
      persistInsert: opts.persistInsert,
    })
    const state = EditorState.create({doc: 'met at @blue'})
    const result = await source(new CompletionContext(state, 12, true))
    const option = result!.options[0]
    const apply = option.apply
    if (typeof apply !== 'function') throw new Error('expected a function apply')
    return {option, apply, state}
  }

  it('dispatches into a live (attached) view', async () => {
    const {option, apply, state} = await buildOption({resolveName: 'Blue Bottle'})
    const view = new EditorView({state, parent: document.body})
    try {
      apply(view, option, 7, 12)
      await vi.waitFor(() => {
        expect(view.state.doc.toString()).toBe('met at [[Blue Bottle]]')
      })
    } finally {
      view.destroy()
    }
  })

  it('falls back to persistInsert when the view is gone before resolution settles', async () => {
    const persisted: Array<{triggerText: string; insert: string}> = []
    const {option, apply, state} = await buildOption({
      resolveName: 'Blue Bottle',
      persistInsert: async args => { persisted.push(args) },
    })
    const view = new EditorView({state, parent: document.body})
    try {
      apply(view, option, 7, 12)
    } finally {
      // The collision toast steals focus; the per-block editor unmounts
      // and destroys the view before resolvePlace settles.
      view.destroy()
    }
    await vi.waitFor(() => {
      expect(persisted).toEqual([{triggerText: '@blue', insert: '[[Blue Bottle]]'}])
    })
  })
})
