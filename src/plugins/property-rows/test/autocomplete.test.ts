// @vitest-environment happy-dom
import {EditorState} from '@codemirror/state'
import {CompletionContext} from '@codemirror/autocomplete'
import {afterAll, afterEach, beforeAll, beforeEach, expect, it, vi} from 'vitest'
import {ChangeScope, seedProperty, seedType} from '@/data/api'
import {kernelPropertyUiExtension} from '@/components/propertyEditors/typesPropertyUi'
import {definitionSeedsFacet, typeSeedsFacet} from '@/data/facets'
import {propertyFieldContent} from '@/data/propertyChildren'
import {typesProp} from '@/data/properties'
import {createTestDb, resetTestDb, type TestDb} from '@/data/test/createTestDb'
import {createTestRepo} from '@/data/test/createTestRepo'
import type {Repo} from '@/data/repo'
import {propertyCompletionSource} from '../autocomplete'

const note = seedProperty({seedKey: 'test/property/completion-note', revision: 1, name: 'test:note', preset: 'string', changeScope: ChangeScope.BlockDefault})
const tags = seedProperty({seedKey: 'test/property/completion-tags', revision: 1, name: 'test:tags', preset: 'string-list', changeScope: ChangeScope.BlockDefault})
const matching = ['status', 'status detail', 'past status', ...Array.from({length: 12}, (_, i) => `status ${i}`)].map(name => seedProperty({seedKey: `test/property/${name}`, revision: 1, name, preset: 'string', changeScope: ChangeScope.BlockDefault}))
const privateFields = [
  seedProperty({seedKey: 'test/property/hidden', revision: 1, name: 'hidden choice', preset: 'string', hidden: true, changeScope: ChangeScope.BlockDefault}),
  seedProperty({seedKey: 'test/property/preference', revision: 1, name: 'preference choice', preset: 'string', changeScope: ChangeScope.UserPrefs}),
]
const typedMissing = seedProperty({seedKey: 'test/property/completion-status-focus', revision: 1, name: 'status focus', preset: 'string', changeScope: ChangeScope.BlockDefault})
const typedSecond = seedProperty({seedKey: 'test/property/completion-status-second', revision: 1, name: 'status second', preset: 'string', changeScope: ChangeScope.BlockDefault})
const typedSubstring = seedProperty({seedKey: 'test/property/completion-past-status-focus', revision: 1, name: 'past status focus', preset: 'string', changeScope: ChangeScope.BlockDefault})
const typedList = seedProperty({seedKey: 'test/property/completion-status-list', revision: 1, name: 'status list', preset: 'string-list', changeScope: ChangeScope.BlockDefault})
const typedFieldOnly = seedProperty({seedKey: 'test/property/completion-status-field-only', revision: 1, name: 'status field-only', preset: 'string', changeScope: ChangeScope.BlockDefault})
const typedStaleCell = seedProperty({seedKey: 'test/property/completion-status-stale-cell', revision: 1, name: 'status stale-cell', preset: 'string', changeScope: ChangeScope.BlockDefault})
const typeA = seedType({seedKey: 'test/type/completion-a', revision: 1, id: 'test:completion-a', label: 'Completion A', properties: [matching[0]!, typedMissing, typedSubstring, privateFields[0]]})
const typeB = seedType({seedKey: 'test/type/completion-b', revision: 1, id: 'test:completion-b', label: 'Completion B', properties: [matching[1]!, typedMissing, typedSecond, typedList, typedFieldOnly, typedStaleCell]})
const typedFields = [typedMissing, typedSecond, typedSubstring, typedList, typedFieldOnly, typedStaleCell]
let h: TestDb
let repo: Repo
beforeAll(async () => { h = await createTestDb() })
afterAll(async () => { await h.cleanup() })
afterEach(() => { vi.restoreAllMocks(); document.body.replaceChildren() })
beforeEach(async () => {
  await resetTestDb(h.db)
  repo = createTestRepo({db: h.db, extensions: [kernelPropertyUiExtension,
    ...[note, tags, ...matching, ...privateFields, ...typedFields].map(schema => definitionSeedsFacet.of(schema)),
    typeSeedsFacet.of(typeA), typeSeedsFacet.of(typeB)]}).repo
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
it('puts missing fields from every owner type before ordinary matches within the cap', async () => {
  await repo.block('owner').set(typesProp, [typeA.id, typeB.id])
  const fieldOnlyResolution = repo.propertySchemaResolverFor('ws').resolve(typedFieldOnly.name)
  if (fieldOnlyResolution.status !== 'resolved') throw new Error('Missing field-only definition')
  await repo.mutate.createChild({parentId: 'owner', content: propertyFieldContent(fieldOnlyResolution.schema.fieldId)})

  const missingResolution = repo.propertySchemaResolverFor('ws').resolve(typedMissing.name)
  if (missingResolution.status !== 'resolved') throw new Error('Missing declared definition')
  const referenceId = await repo.mutate.createChild({parentId: 'owner', content: `((${missingResolution.schema.fieldId}))`})
  expect((await repo.load(referenceId))?.referenceTargetId).toBe(missingResolution.schema.fieldId)
  expect((await repo.load(referenceId))?.isFieldForm).not.toBe(true)

  const staleResolution = repo.propertySchemaResolverFor('ws').resolve(typedStaleCell.name)
  if (staleResolution.status !== 'resolved') throw new Error('Missing stale-cell definition')
  const stored = {...repo.block('owner').peek()!.properties,
    [matching[0]!.name]: '',
    [matching[1]!.name]: '',
    [typedList.name]: [],
    [typedStaleCell.name]: 'stored without a field row',
  }
  await h.db.writeTransaction(tx => tx.execute('UPDATE blocks SET properties_json = ? WHERE id = ?', [JSON.stringify(stored), 'owner']))
  repo.cache.deleteSnapshot('owner')
  const owner = await repo.block('owner').load()
  expect(Object.hasOwn(owner!.properties, matching[0]!.name)).toBe(true)
  expect(Object.hasOwn(owner!.properties, matching[1]!.name)).toBe(true)
  expect(Object.hasOwn(owner!.properties, typedList.name)).toBe(true)
  const ownerChildren = await repo.query.children({id: 'owner', propertyChildren: 'all'}).load()
  expect(ownerChildren.some(row => row.isFieldForm && row.referenceTargetId === fieldOnlyResolution.schema.fieldId)).toBe(true)
  expect(ownerChildren.some(row => row.isFieldForm && row.referenceTargetId === staleResolution.schema.fieldId)).toBe(false)

  const names = (await complete('::status'))!.options.map(option => option.label)
  expect(names.slice(0, 5)).toEqual(['status', typedMissing.name, typedSecond.name, typedSubstring.name, 'status 0'])
  expect(names).toHaveLength(8)
  expect(names.filter(name => name === typedMissing.name)).toHaveLength(1)
  expect((await complete('::STATUS'))!.options[0]?.label).toBe('status')

  const filtered = (await complete('::status f'))!.options.map(option => option.label)
  expect(filtered).toEqual([typedMissing.name, typedSubstring.name, typedFieldOnly.name, 'Create “status f”'])
  expect((await complete('::status d'))!.options.map(option => option.label)).toEqual(['status detail', 'Create “status d”'])
  expect((await complete('::status l'))!.options.map(option => option.label)).toEqual([typedList.name, 'Create “status l”'])
  expect((await complete('::status stale'))!.options.map(option => option.label)).toEqual([typedStaleCell.name, 'Create “status stale”'])
  const partial = (await complete('::stat'))!.options.map(option => option.label)
  expect(partial.indexOf(typedMissing.name)).toBeLessThan(partial.indexOf('status'))
  expect(await complete('::hidden choice', 15, true)).toBeNull()
})
it('keeps a declared field with unavailable identity as an ordinary suggestion', async () => {
  await repo.block('owner').set(typesProp, [typeA.id])
  const resolver = repo.propertySchemaResolverFor('ws')
  const resolve = resolver.resolve.bind(resolver)
  vi.spyOn(repo, 'propertySchemaResolverFor').mockReturnValue(resolver)
  const resolveSpy = vi.spyOn(resolver, 'resolve').mockImplementation(name => name === typedMissing.name
    ? {status: 'identity-unavailable', reason: 'definition-unavailable'}
    : resolve(name))
  expect((await complete('::focus'))!.options.map(option => option.label))
    .toEqual([typedSubstring.name, typedMissing.name, 'Create “focus”'])
  expect(resolveSpy).toHaveBeenCalledWith(typedMissing.name)
})
it('keeps ordinary suggestions when the source owner is unavailable', async () => {
  await h.db.execute("UPDATE blocks SET parent_id = 'missing-owner' WHERE id = 'source'")
  repo.cache.deleteSnapshot('source')
  expect(await repo.load('missing-owner')).toBeNull()
  expect((await complete('::status'))!.options[0].label).toBe('status')
})
it('only enumerates owner children when a matching declared field could be missing', async () => {
  const originalQuery = repo.query
  const children = vi.fn(originalQuery.children)
  const writable = repo as {query: Repo['query']}
  writable.query = new Proxy(originalQuery, {get: (target, key) => key === 'children' ? children : Reflect.get(target, key)})
  try {
    await complete()
    expect(children).not.toHaveBeenCalled()
    await repo.block('owner').set(typesProp, [typeA.id])
    children.mockClear()
    await complete('::focus')
    expect(children).toHaveBeenCalledWith({id: 'owner', propertyChildren: 'all'})
    children.mockClear()
    await complete('::unrelated')
    expect(children).not.toHaveBeenCalled()
  } finally {
    writable.query = originalQuery
  }
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
it('offers Create last automatically and compares existing names without case', async () => {
  expect((await complete('::some prose'))!.options.map(option => option.label)).toEqual(['Create “some prose”'])
  expect((await complete('::stat'))!.options.at(-1)?.label).toBe('Create “stat”')
  expect((await complete('::stat'))!.options[0].label).toBe('status')
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
