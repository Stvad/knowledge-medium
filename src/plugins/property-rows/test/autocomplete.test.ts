import {EditorState} from '@codemirror/state'
import {CompletionContext} from '@codemirror/autocomplete'
import {afterAll, beforeAll, beforeEach, expect, it} from 'vitest'
import {ChangeScope, seedProperty} from '@/data/api'
import {definitionSeedsFacet} from '@/data/facets'
import {createTestDb, resetTestDb, type TestDb} from '@/data/test/createTestDb'
import {createTestRepo} from '@/data/test/createTestRepo'
import type {Repo} from '@/data/repo'
import {propertyCompletionSource} from '../autocomplete'

const note = seedProperty({seedKey: 'test/property/completion-note', revision: 1, name: 'test:note', preset: 'string', changeScope: ChangeScope.BlockDefault})
let h: TestDb
let repo: Repo
beforeAll(async () => { h = await createTestDb() })
afterAll(async () => { await h.cleanup() })
beforeEach(async () => {
  await resetTestDb(h.db)
  repo = createTestRepo({db: h.db, extensions: [definitionSeedsFacet.of(note)]}).repo
  repo.setActiveWorkspaceId('ws')
  await h.db.execute("INSERT INTO workspaces (id, name, owner_user_id, create_time, update_time, encryption_mode, properties_migration) VALUES ('ws', 'Test', 'user', 1, 1, 'none', 'children')")
  await repo.tx(async tx => {
    await tx.create({id: 'owner', workspaceId: 'ws', parentId: null, orderKey: 'a0', content: 'owner'})
    await tx.create({id: 'source', workspaceId: 'ws', parentId: 'owner', orderKey: 'a0', content: '::'})
  }, {scope: ChangeScope.BlockDefault})
})
const complete = (doc = '::', pos = doc.length) => propertyCompletionSource({repo, block: repo.block('source')})(new CompletionContext(EditorState.create({doc, selection: {anchor: pos}}), pos, false))
it('offers definitions without writing or replacing the typed marker', async () => {
  const before = await h.db.getAll('SELECT * FROM blocks ORDER BY id')
  expect((await complete())?.options.map(option => option.label)).toContain(note.name)
  expect(await h.db.getAll('SELECT * FROM blocks ORDER BY id')).toEqual(before)
})
it('offers creation for a new name', async () => {
  expect((await complete('::new field'))?.options.map(option => option.label)).toEqual(['Create “new field”'])
})
it.each(['text::', '::one\ntwo', ':'])('does not offer completion in ordinary text: %s', async text => {
  expect(await complete(text)).toBeNull()
})
it('does not offer at a caret before the end', async () => { expect(await complete('::field', 2)).toBeNull() })
it.each(['cell', 'read-only', 'root', 'children', 'properties'])('refuses before any completion dispatch: %s', async kind => {
  if (kind === 'cell') await h.db.execute("UPDATE workspaces SET properties_migration = 'cell'")
  if (kind === 'read-only') Object.defineProperty(repo, 'isReadOnly', {value: true})
  if (kind === 'root') await repo.tx(tx => tx.move('source', {parentId: null, orderKey: 'a1'}), {scope: ChangeScope.BlockDefault})
  if (kind === 'children') await repo.mutate.createChild({parentId: 'source', content: 'keep'})
  if (kind === 'properties') await h.db.writeTransaction(tx => tx.execute("UPDATE blocks SET properties_json = ? WHERE id = 'source'", [JSON.stringify({'custom:keep': 'value'})]))
  repo.cache.deleteSnapshot('source')
  const before = await h.db.getAll('SELECT * FROM blocks ORDER BY id')
  expect(await complete()).toBeNull()
  expect(await h.db.getAll('SELECT * FROM blocks ORDER BY id')).toEqual(before)
})
