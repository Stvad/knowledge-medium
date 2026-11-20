// @vitest-environment happy-dom
import {acceptCompletion, autocompletion, completionStatus, currentCompletions, startCompletion} from '@codemirror/autocomplete'
import {EditorState} from '@codemirror/state'
import {EditorView} from '@codemirror/view'
import {afterAll, afterEach, beforeAll, beforeEach, expect, it, vi} from 'vitest'
import {ChangeScope, codecs, defineProperty} from '@/data/api'
import {aliasesProp, typesProp} from '@/data/properties'
import type {Repo} from '@/data/repo'
import {createTestDb, resetTestDb, type TestDb} from '@/data/test/createTestDb'
import {createTestRepo} from '@/data/test/createTestRepo'
import {valueAutocomplete} from '../valueAutocomplete'

const WS = 'ws'
const constrained = defineProperty('assignee', {codec: codecs.ref({targetTypes: ['person']}), defaultValue: '', changeScope: ChangeScope.BlockDefault})
const emptyEnum = defineProperty('empty', {codec: codecs.enum<string>([]), defaultValue: '', changeScope: ChangeScope.BlockDefault})
const unconstrained = defineProperty('link', {codec: codecs.ref(), defaultValue: '', changeScope: ChangeScope.BlockDefault})
let db: TestDb
let repo: Repo
let view: EditorView | undefined
const swallowSelectionChange = (event: Event) => event.stopImmediatePropagation()
beforeAll(async () => { db = await createTestDb() })
afterAll(async () => { await db.cleanup() })
beforeEach(async () => {
  await resetTestDb(db.db)
  repo = createTestRepo({db: db.db}).repo
  repo.setActiveWorkspaceId(WS)
  window.addEventListener('selectionchange', swallowSelectionChange, true)
  await create('value', '', [], [])
})
afterEach(() => {
  view?.destroy()
  view = undefined
  window.removeEventListener('selectionchange', swallowSelectionChange, true)
})

const create = async (id: string, content: string, aliases: string[], types = ['person']) => {
  await repo.tx(tx => tx.create({
    id, workspaceId: WS, parentId: null, orderKey: `key-${id}`, content,
    properties: {[aliasesProp.name]: aliasesProp.codec.encode(aliases), [typesProp.name]: typesProp.codec.encode(types)},
  }), {scope: ChangeScope.BlockDefault})
}

const open = async (text: string) => {
  view = new EditorView({parent: document.body, state: EditorState.create({
    doc: text, selection: {anchor: text.length},
    extensions: [autocompletion({activateOnTypingDelay: 0}), ...valueAutocomplete({repo, block: repo.block('value'), propertyValueSchema: constrained})],
  })})
  view.focus()
  if (text) startCompletion(view)
  await vi.waitFor(() => expect(completionStatus(view!.state)).toBe('active'))
  expect(currentCompletions(view.state)).toHaveLength(1)
  await vi.waitFor(() => expect(acceptCompletion(view!)).toBe(true))
  return view.state.doc.toString()
}

it('opens an empty constrained value and inserts a named reference', async () => {
  await create('alice', 'A person', ['Alice'])
  expect(await open('')).toBe('[[Alice]]')
})

it('inserts the secondary alias that matched the query', async () => {
  await create('alice', 'A person', ['Alice', 'Ally'])
  expect(await open('Ally')).toBe('[[Ally]]')
})

it('uses an alias for a content match', async () => {
  await create('alice', 'Pianist', ['Alice'])
  expect(await open('Pianist')).toBe('[[Alice]]')
})

it('inserts a block reference when the target has no alias', async () => {
  await create('bob', 'Violinist', [])
  expect(await open('Violinist')).toBe('((bob))')
})

it('chooses a faithful alternate when the first alias cannot be a wikilink', async () => {
  await create('alice', 'Pianist', ['Broken]]alias', 'Alice'])
  expect(await open('Pianist')).toBe('[[Alice]]')
})

it('does not install an automatic source for unconstrained reference values', async () => {
  await create('alice', 'Alice', ['Alice'])
  const extensions = valueAutocomplete({repo, block: repo.block('value'), propertyValueSchema: unconstrained})
  expect(extensions).toEqual([])
  view = new EditorView({parent: document.body, extensions: [autocompletion(), ...extensions]})
  view.focus()
  view.dispatch({changes: {from: 0, insert: 'ali'}, selection: {anchor: 3}, userEvent: 'input.type'})
  expect(view.state.languageDataAt('autocomplete', 3)).toEqual([])
})

it('does not insert a contested alias that resolves to another block', async () => {
  await create('a-first', 'Other', ['Shared'], ['place'])
  await create('alice', 'Pianist', ['Alice'])
  // A sync-applied collision bypasses the local collision processor.
  await db.db.writeTransaction(tx => tx.execute('UPDATE blocks SET properties_json = ? WHERE id = ?', [
    JSON.stringify({[aliasesProp.name]: ['Shared', 'Alice'], [typesProp.name]: ['person']}), 'alice',
  ]))
  expect((await repo.query.aliasLookup({workspaceId: WS, alias: 'Shared'}).load())?.id).toBe('a-first')
  expect(await open('Pianist')).toBe('[[Alice]]')
})

it('can insert a good alias even when the block id cannot be written as a reference', async () => {
  await create('unsafe id', 'Pianist', ['Alice'])
  expect(await open('Pianist')).toBe('[[Alice]]')
})

it('does not install automatic completion for an enum with no options', () => {
  const extensions = valueAutocomplete({repo, block: repo.block('value'), propertyValueSchema: emptyEnum})
  expect(extensions).toEqual([])
})
