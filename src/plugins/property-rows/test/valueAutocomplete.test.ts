// @vitest-environment happy-dom
import {autocompletion, CompletionContext, completionStatus, currentCompletions} from '@codemirror/autocomplete'
import {EditorState} from '@codemirror/state'
import {EditorView} from '@codemirror/view'
import {expect, it, vi} from 'vitest'
import {ChangeScope, codecs, defineProperty} from '@/data/api'
import type {Repo} from '@/data/repo'
import {valueAutocomplete, valueCompletionSource} from '../valueAutocomplete'

const enumSchema = defineProperty('status', {codec: codecs.enum([{value: ' open ', label: 'Open'}, {value: 'done', label: 'Done'}]), defaultValue: 'done', changeScope: ChangeScope.BlockDefault})
const refSchema = defineProperty('owner', {codec: codecs.ref({targetTypes: ['person']}), defaultValue: '', changeScope: ChangeScope.BlockDefault})
const search = vi.fn(async () => [{id: 'target', label: 'Alice'}])
const complete = async (schema: typeof enumSchema | typeof refSchema, doc: string) => {
  const state = EditorState.create({doc, selection: {anchor: doc.length}})
  return valueCompletionSource(schema, search)(new CompletionContext(state, doc.length, false))
}

it('filters enum labels and inserts the encoded value, preserving whitespace', async () => {
  const result = await complete(enumSchema, 'op')
  expect(result?.options.map(option => option.label)).toEqual(['Open'])
  const view = new EditorView({doc: 'op'})
  const option = result!.options[0]!
  if (typeof option.apply !== 'function') throw new Error('Missing apply')
  option.apply(view, option, 0, 2)
  expect(view.state.doc.toString()).toBe('" open "')
  view.destroy()
})

it('searches constrained references and inserts a block reference', async () => {
  search.mockClear()
  const result = await complete(refSchema, 'ali')
  expect(search).toHaveBeenCalledWith('ali', ['person'])
  const view = new EditorView({doc: 'ali'})
  const option = result!.options[0]!
  if (typeof option.apply !== 'function') throw new Error('Missing apply')
  option.apply(view, option, 0, 3)
  expect(view.state.doc.toString()).toBe('((target))')
  view.destroy()
})

it('offers empty values and leaves explicit link triggers to their own sources', async () => {
  expect((await complete(enumSchema, ''))?.options).toHaveLength(2)
  expect((await complete(refSchema, ''))?.options).toHaveLength(1)
  expect(await complete(refSchema, '[[ali')).toBeNull()
  expect(await complete(refSchema, '((ali')).toBeNull()
})


it('opens on focus of an empty enum value and updates as the user types', async () => {
  const swallowSelectionChange = (event: Event) => event.stopImmediatePropagation()
  window.addEventListener('selectionchange', swallowSelectionChange, true)
  const view = new EditorView({parent: document.body, extensions: [
    autocompletion({activateOnTypingDelay: 0}),
    ...valueAutocomplete({repo: {} as Repo, propertyValueSchema: enumSchema}),
  ]})
  try {
    view.focus()
    await vi.waitFor(() => expect(currentCompletions(view.state).map(option => option.label)).toEqual(['Open', 'Done']))
    view.dispatch({changes: {from: 0, insert: 'do'}, selection: {anchor: 2}, userEvent: 'input.type'})
    await vi.waitFor(() => {
      expect(completionStatus(view.state)).toBe('active')
      expect(currentCompletions(view.state).map(option => option.label)).toEqual(['Done'])
    })
  } finally {
    view.destroy()
    window.removeEventListener('selectionchange', swallowSelectionChange, true)
  }
})
