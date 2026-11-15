// @vitest-environment happy-dom
import {EditorState} from '@codemirror/state'
import {CompletionContext} from '@codemirror/autocomplete'
import * as completion from '@codemirror/autocomplete'
import {afterAll, afterEach, beforeAll, beforeEach, expect, it, vi} from 'vitest'
import {ChangeScope, seedProperty} from '@/data/api'
import {kernelPropertyUiExtension} from '@/components/propertyEditors/typesPropertyUi'
import {definitionSeedsFacet} from '@/data/facets'
import {createTestDb, resetTestDb, type TestDb} from '@/data/test/createTestDb'
import {createTestRepo} from '@/data/test/createTestRepo'
import type {Repo} from '@/data/repo'
import {EditorView} from '@codemirror/view'
import {handlePropertyValueEnter, propertyCompletionSource} from '../autocomplete'

vi.mock('@codemirror/autocomplete', async importOriginal => {
  const actual = await importOriginal<typeof import('@codemirror/autocomplete')>()
  return {...actual, completionStatus: vi.fn(actual.completionStatus)}
})

const note = seedProperty({seedKey: 'test/property/completion-note', revision: 1, name: 'test:note', preset: 'string', changeScope: ChangeScope.BlockDefault})
const tags = seedProperty({seedKey: 'test/property/completion-tags', revision: 1, name: 'test:tags', preset: 'string-list', changeScope: ChangeScope.BlockDefault})
const matching = ['status', 'status detail', 'past status', ...Array.from({length: 12}, (_, i) => `status ${i}`)].map(name => seedProperty({seedKey: `test/property/${name}`, revision: 1, name, preset: 'string', changeScope: ChangeScope.BlockDefault}))
const privateFields = [
  seedProperty({seedKey: 'test/property/hidden', revision: 1, name: 'hidden choice', preset: 'string', hidden: true, changeScope: ChangeScope.BlockDefault}),
  seedProperty({seedKey: 'test/property/preference', revision: 1, name: 'preference choice', preset: 'string', changeScope: ChangeScope.UserPrefs}),
]
let h: TestDb
let repo: Repo
beforeAll(async () => { h = await createTestDb() })
afterAll(async () => { await h.cleanup() })
afterEach(() => { vi.restoreAllMocks(); document.body.replaceChildren() })
beforeEach(async () => {
  await resetTestDb(h.db)
  repo = createTestRepo({db: h.db, extensions: [kernelPropertyUiExtension, ...[note, tags, ...matching, ...privateFields].map(schema => definitionSeedsFacet.of(schema))]}).repo
  repo.setActiveWorkspaceId('ws')
  await h.db.execute("INSERT INTO workspaces (id, name, owner_user_id, create_time, update_time, encryption_mode, properties_migration) VALUES ('ws', 'Test', 'user', 1, 1, 'none', 'children')")
  await repo.tx(async tx => {
    await tx.create({id: 'owner', workspaceId: 'ws', parentId: null, orderKey: 'a0', content: 'owner'})
    await tx.create({id: 'source', workspaceId: 'ws', parentId: 'owner', orderKey: 'a0', content: '::'})
  }, {scope: ChangeScope.BlockDefault})
})
const complete = (doc = '::', pos = doc.length, explicit = false) => propertyCompletionSource({repo, block: repo.block('source'), childBacked: true})(new CompletionContext(EditorState.create({doc, selection: {anchor: pos}}), pos, explicit))
it('offers definitions without writing or replacing the typed marker', async () => {
  const before = await h.db.getAll('SELECT * FROM blocks ORDER BY id')
  expect((await complete('::test'))?.options.map(option => option.label)).toContain(note.name)
  expect((await complete())?.options.some(option => option.label.startsWith('Create'))).toBe(false)
  expect((await complete(`::${note.name}`))?.options.map(option => option.label)).toEqual([note.name])
  expect(await h.db.getAll('SELECT * FROM blocks ORDER BY id')).toEqual(before)
})
it('ranks exact names before prefixes before substrings and caps the result', async () => {
  const names = (await complete('::status'))!.options.map(option => option.label)
  expect(names[0]).toBe('status')
  expect(names).toHaveLength(8)
  expect(names.slice(1).every(name => name.startsWith('status'))).toBe(true)
  const detail = (await complete('::status detail'))!.options
  expect(detail[0].label).toBe('status detail')
  const explicit = (await complete('::stat', 6, true))!.options
  expect(explicit).toHaveLength(8)
  expect(explicit.at(-1)?.label).toBe('Create “stat”')
})
it('uses picker visibility and only ordinary undoable scopes', async () => {
  const names = (await complete())!.options.map(option => option.label)
  expect(names).not.toContain('hidden choice')
  expect(names).not.toContain('preference choice')
  for (const name of ['system:propertyDisplay', 'renderer', 'types', 'seed:key', 'property-schema:name', 'block-type:properties']) {
    expect(await complete(`::${name}`)).toBeNull()
  }
  expect(await complete('::hidden choice', 15, true)).toBeNull()
  expect(await complete('::system:new field', 18, true)).toBeNull()
})
it('offers Create only on an explicit request and compares existing names without case', async () => {
  expect(await complete('::some prose')).toBeNull()
  expect((await complete('::STATUS', 8, true))!.options.some(option => option.label.startsWith('Create'))).toBe(false)
})
it.each(['::((field))', '::name [[link', '::name ((block'])('does not complete property or reference grammar: %s', async text => {
  expect(await complete(text, text.length, true)).toBeNull()
})
it('does not repurpose an existing field row even with unrelated editor text', async () => {
  await repo.tx(tx => tx.update('source', {content: '::((field))'}), {scope: ChangeScope.BlockDefault})
  expect(repo.block('source').peek()?.isFieldForm).toBe(true)
  expect(await complete('::status')).toBeNull()
})
it('offers creation for a new name', async () => {
  expect((await complete('::new field', 11, true))?.options.map(option => option.label)).toEqual(['Create “new field”'])
})
it.each(['text::', '::one\ntwo', ':'])('does not offer completion in ordinary text: %s', async text => {
  expect(await complete(text)).toBeNull()
})
it('does not offer at a caret before the end', async () => { expect(await complete('::field', 2)).toBeNull() })
it.each(['cell', 'read-only', 'root', 'children', 'properties'])('refuses before any completion dispatch: %s', async kind => {
  if (kind === 'cell') {
    expect(await propertyCompletionSource({repo, block: repo.block('source'), childBacked: false})(new CompletionContext(EditorState.create({doc: '::'}), 2, false))).toBeNull()
    return
  }
  if (kind === 'read-only') Object.defineProperty(repo, 'isReadOnly', {value: true})
  if (kind === 'root') await repo.tx(tx => tx.move('source', {parentId: null, orderKey: 'a1'}), {scope: ChangeScope.BlockDefault})
  if (kind === 'children') await repo.mutate.createChild({parentId: 'source', content: 'keep'})
  if (kind === 'properties') await h.db.writeTransaction(tx => tx.execute("UPDATE blocks SET properties_json = ? WHERE id = 'source'", [JSON.stringify({'custom:keep': 'value'})]))
  repo.cache.deleteSnapshot('source')
  const before = await h.db.getAll('SELECT * FROM blocks ORDER BY id')
  expect(await complete()).toBeNull()
  expect(await h.db.getAll('SELECT * FROM blocks ORDER BY id')).toEqual(before)
})

it('does not replace a selected range with a property', async () => {
  const state = EditorState.create({doc: '::', selection: {anchor: 0, head: 2}})
  expect(await propertyCompletionSource({repo, block: repo.block('source'), childBacked: true})(new CompletionContext(state, 2, false))).toBeNull()
})
it('offers nothing to an editor without a block', async () => {
  const state = EditorState.create({doc: '::', selection: {anchor: 2}})
  expect(await propertyCompletionSource({repo})(new CompletionContext(state, 2, false))).toBeNull()
})
it.each(['key', 'defaultPrevented', 'shiftKey', 'metaKey', 'ctrlKey', 'altKey', 'readonly', 'ui', 'selection', 'middle', 'ordinary', 'scalar', 'completion', 'missing-placeholder', 'other-field', 'other-scope', 'hidden-placeholder'])('list member Enter declines %s without changing rows', async kind => {
  await repo.block('owner').set(tags, ['saved'])
  await repo.block('owner').set(note, 'saved scalar')
  const fields = await repo.query.children({id: 'owner', propertyChildren: 'all'}).load()
  const definition = repo.propertySchemaResolverFor('ws').resolve(kind === 'scalar' ? note.name : tags.name)
  if (definition.status !== 'resolved') throw new Error('Missing definition')
  const field = fields.find(row => row.referenceTargetId === definition.schema.fieldId)!
  const [value] = await repo.query.children({id: field.id, propertyChildren: 'all'}).load()
  const placeholder = document.createElement('div')
  placeholder.dataset.propertyPlaceholder = kind === 'other-field' ? 'other-field' : field.id
  placeholder.dataset.outlinePlaceholderScope = kind === 'other-scope' ? 'other-scope' : 'test-scope'
  if (kind === 'hidden-placeholder') placeholder.style.display = 'none'
  if (kind !== 'missing-placeholder') document.body.append(placeholder)
  if (kind === 'readonly') Object.defineProperty(repo, 'isReadOnly', {value: true})
  if (kind === 'completion') vi.mocked(completion.completionStatus).mockReturnValueOnce('active')
  const event = {key: kind === 'key' ? 'x' : 'Enter', [kind]: true, preventDefault: vi.fn(), stopPropagation: vi.fn()} as unknown as KeyboardEvent
  const state = EditorState.create({doc: 'saved', selection: {anchor: kind === 'selection' ? 0 : kind === 'middle' ? 2 : 5, head: kind === 'selection' ? 5 : undefined}})
  const before = await h.db.getAll('SELECT * FROM blocks ORDER BY id')
  const view = new EditorView({state})
  try {
    expect(handlePropertyValueEnter({repo, block: repo.block(kind === 'ordinary' ? 'source' : value.id),
      uiStateBlock: kind === 'ui' ? undefined : repo.block('owner'), renderScopeId: 'test-scope'}, event, view)).toBe(false)
  } finally { view.destroy() }
  expect(event.preventDefault).not.toHaveBeenCalled()
  expect(await h.db.getAll('SELECT * FROM blocks ORDER BY id')).toEqual(before)
})
