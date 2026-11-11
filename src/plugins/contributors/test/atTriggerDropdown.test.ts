// @vitest-environment happy-dom
/** Both `@` sources installed together, driven through CodeMirror's own
 *  merge: each position opens at most one of them. */
import { autocompletion, completionStatus, currentCompletions, startCompletion } from '@codemirror/autocomplete'
import { EditorState } from '@codemirror/state'
import { EditorView } from '@codemirror/view'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { placeCompletionSource } from '@/plugins/geo/placeAutocomplete'
import { contributorMentionSource } from '../mentionAutocomplete'

const placeSource = placeCompletionSource({
  getCandidates: async () => [{id: 'p', source: 'local', label: 'Clinic', insertText: 'Clinic'}],
  resolvePlace: async () => null,
})
const contributorSource = contributorMentionSource(async query => [
  {id: 'b', name: 'Zeno', kind: 'human' as const, wikilink: '[[Zeno]]'},
  {id: 'a', name: 'Clio', kind: 'agent' as const, wikilink: '[[Clio]]'},
].filter(c => c.name.toLowerCase().startsWith(query.toLowerCase())))

let view: EditorView | undefined
afterEach(() => view?.destroy())

/** The dropdown's labels once every source has answered; `[]` when none opened it. */
const dropdownFor = async (doc: string, {contributorsFirst = false} = {}): Promise<string[]> => {
  const sources = [{autocomplete: placeSource}, {autocomplete: contributorSource}]
  if (contributorsFirst) sources.reverse()
  view = new EditorView({
    parent: document.body,
    state: EditorState.create({
      doc,
      selection: {anchor: doc.length},
      extensions: [
        autocompletion(),
        EditorState.languageData.of(() => sources),
      ],
    }),
  })
  startCompletion(view)
  expect(completionStatus(view.state)).toBe('pending')
  await vi.waitFor(() => expect(completionStatus(view!.state)).not.toBe('pending'))
  return currentCompletions(view.state).map(c => c.label)
}

describe('the @ trigger family in one editor', () => {
  it('a bare @ puts the places hand-off first, then every contributor in input order', async () => {
    const expected = ['Search places (@@)…', 'Zeno', 'Clio']
    expect(await dropdownFor('ask @')).toEqual(expected)
    expect(await dropdownFor('ask @', {contributorsFirst: true})).toEqual(expected)
  })

  it('@query offers only the contributors it matches', async () => {
    expect(await dropdownFor('ask @cl')).toEqual(['Clio'])
  })

  it('@word matching no contributor opens nothing, leaving Enter to the editor', async () => {
    expect(await dropdownFor('ping @john about it')).toEqual([])
  })

  it('@@query offers only places', async () => {
    expect(await dropdownFor('ask @@cl')).toEqual(['Clinic'])
  })
})
