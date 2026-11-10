// @vitest-environment happy-dom
/** The `@` dropdown merges two plugins' sources; this drives both through
 *  CodeMirror's own merge and sort to pin the order a user sees. */
import { autocompletion, currentCompletions, startCompletion } from '@codemirror/autocomplete'
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
  {id: 'a', name: 'Clio', kind: 'agent' as const},
  {id: 'v', name: 'Ada', kind: 'human' as const},
].filter(c => c.name.toLowerCase().startsWith(query.toLowerCase())))

let view: EditorView | undefined
afterEach(() => view?.destroy())

const dropdownFor = async (doc: string): Promise<string[]> => {
  view = new EditorView({
    parent: document.body,
    state: EditorState.create({
      doc,
      selection: {anchor: doc.length},
      extensions: [
        autocompletion(),
        // Places registered FIRST: the order must come from the sections,
        // not from registration order.
        EditorState.languageData.of(() => [{autocomplete: placeSource}, {autocomplete: contributorSource}]),
      ],
    }),
  })
  startCompletion(view)
  let labels: string[] = []
  await vi.waitFor(() => {
    labels = currentCompletions(view!.state).map(c => c.label)
    expect(labels.length).toBeGreaterThan(0)
  })
  return labels
}

describe('the merged @ dropdown', () => {
  it('lists contributors above the places hand-off once a query is typed', async () => {
    expect(await dropdownFor('ask @cl')).toEqual(['Clio', 'Search places (@@)…'])
  })

  it('leads with the places hand-off on a bare @, so Enter does not mention anyone', async () => {
    expect(await dropdownFor('ask @')).toEqual(['Search places (@@)…', 'Clio', 'Ada'])
  })

  it('shows only places on @@', async () => {
    expect(await dropdownFor('ask @@cl')).toEqual(['Clinic'])
  })
})
