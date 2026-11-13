import {afterAll, beforeAll, beforeEach, describe, expect, it} from 'vitest'
import {ChangeScope} from '@/data/api'
import {definitionSeedsFacet} from '@/data/facets'
import {seedProperty} from '@/data/propertySeeds'
import {createTestDb, resetTestDb, type TestDb} from '@/data/test/createTestDb'
import {createTestRepo} from '@/data/test/createTestRepo'
import type {Repo} from '@/data/repo'
import {selectInlineProperty, commitInlineProperty} from '@/data/inlineProperty'

const note = seedProperty({seedKey: 'test/property/note', revision: 1, name: 'test:note', preset: 'string', changeScope: ChangeScope.BlockDefault})
const tags = seedProperty({seedKey: 'test/property/tags', revision: 1, name: 'test:tags', preset: 'string-list', changeScope: ChangeScope.BlockDefault})
let h: TestDb
let repo: Repo
beforeAll(async () => { h = await createTestDb() })
afterAll(async () => { await h.cleanup() })
beforeEach(async () => {
  await resetTestDb(h.db)
  repo = createTestRepo({db: h.db, newId: () => crypto.randomUUID(), extensions: [definitionSeedsFacet.of(note), definitionSeedsFacet.of(tags)]}).repo
  repo.setActiveWorkspaceId('ws')
  await h.db.execute("INSERT INTO workspaces (id, name, owner_user_id, create_time, update_time, encryption_mode, properties_migration) VALUES ('ws', 'Test', 'user', 1, 1, 'none', 'children')")
  await repo.tx(async tx => {
    await tx.create({id: 'owner', workspaceId: 'ws', parentId: null, orderKey: 'a0', content: 'Owner'})
    await tx.create({id: 'source', workspaceId: 'ws', parentId: 'owner', orderKey: 'a0', content: '::'})
  }, {scope: ChangeScope.BlockDefault})
  repo.undoManager.clear()
})
const children = (id: string) => repo.query.children({id, propertyChildren: 'all'}).load()

describe('inline property drafts', () => {
  it('selecting deletes only the scaffold; committing creates field and value in one undo step', async () => {
    const selection = await selectInlineProperty(repo.block('owner'), note, repo.block('source'))
    expect(await children('owner')).toEqual([])
    expect(await h.db.getOptional('SELECT id FROM blocks WHERE id = ? AND deleted = 0', ['source'])).toBeNull()
    expect(Object.hasOwn(repo.block('owner').peek()!.properties, note.name)).toBe(false)
    repo.undoManager.clear()
    const target = await commitInlineProperty(repo.block('owner'), selection, 'committed')
    expect(await children('owner')).toHaveLength(1)
    expect(await children(target!.fieldRowId)).toHaveLength(1)
    expect(await repo.block('owner').get(note)).toBe('committed')
    expect(repo.undoManager.depths(ChangeScope.BlockDefault).undo).toBe(1)
    const events = await h.db.getAll('SELECT DISTINCT tx_id FROM row_events WHERE block_id IN (?, ?)', [target!.fieldRowId, target!.valueId])
    expect(events).toHaveLength(1)
    expect(await repo.undo()).toBe(true)
    expect(await children('owner')).toEqual([])
  })

  it('allows filling a scalar field that exists without a value child', async () => {
    const selected = await selectInlineProperty(repo.block('owner'), note)
    await repo.tx(tx => tx.create({workspaceId: 'ws', parentId: 'owner', orderKey: 'a1',
      content: `::((${selected.schema.fieldId}))`, isFieldForm: true, referenceTargetId: selected.schema.fieldId}),
      {scope: ChangeScope.BlockDefault})
    const pending = await selectInlineProperty(repo.block('owner'), note, repo.block('source'))
    expect(pending.fieldRowId).toBeDefined()
    expect(pending.valueId).toBeUndefined()
    await commitInlineProperty(repo.block('owner'), pending, 'first value')
    expect(await repo.block('owner').get(note)).toBe('first value')
  })

  it('an empty draft writes nothing at all', async () => {
    const selection = await selectInlineProperty(repo.block('owner'), note, repo.block('source'))
    const before = await h.db.getAll('SELECT * FROM blocks ORDER BY id')
    expect(await commitInlineProperty(repo.block('owner'), selection, '')).toBeNull()
    expect(await h.db.getAll('SELECT * FROM blocks ORDER BY id')).toEqual(before)
  })

  it('existing scalar navigation deletes the scaffold and preserves the value', async () => {
    await repo.block('owner').set(note, 'saved')
    const fields = (await children('owner')).filter(row => row.isFieldForm)
    const values = await children(fields[0].id)
    const result = await selectInlineProperty(repo.block('owner'), note, repo.block('source'))
    expect(result.valueId).toBe(values[0].id)
    expect(await h.db.getOptional('SELECT id FROM blocks WHERE id = ? AND deleted = 0', ['source'])).toBeNull()
    expect(await children(fields[0].id)).toEqual(values)
    expect(await repo.block('owner').get(note)).toBe('saved')
  })

  it('existing list selection deletes the scaffold without appending an empty member', async () => {
    await repo.block('owner').set(tags, ['saved'])
    const result = await selectInlineProperty(repo.block('owner'), tags, repo.block('source'))
    expect(result.valueId).toBeUndefined()
    expect(await h.db.getOptional('SELECT id FROM blocks WHERE id = ? AND deleted = 0', ['source'])).toBeNull()
    expect(await repo.block('owner').get(tags)).toEqual(['saved'])
    expect(await children(result.fieldRowId!)).toHaveLength(1)
    await commitInlineProperty(repo.block('owner'), result, 'new')
    expect(await repo.block('owner').get(tags)).toEqual(['saved', 'new'])
    expect(await children(result.fieldRowId!)).toHaveLength(2)
  })

  it.each([
    {schema: note, value: 'keep pending text'},
    {schema: tags, value: ['keep', 'members']},
  ])('refuses to replace a pending stored value for $schema.name with empty children', async ({schema, value}) => {
    await h.db.writeTransaction(tx => tx.execute(
      'UPDATE blocks SET properties_json = ? WHERE id = ?', [JSON.stringify({[schema.name]: value}), 'owner']))
    expect((await children('owner')).map(row => row.id)).toEqual(['source'])
    const before = await h.db.getAll('SELECT * FROM blocks ORDER BY id')
    await expect(selectInlineProperty(repo.block('owner'), schema, repo.block('source'))).rejects.toThrow(/stored value/)
    expect(await h.db.getAll('SELECT * FROM blocks ORDER BY id')).toEqual(before)
  })

  it.each(['cell', 'missing owner', 'deleted owner', 'missing source', 'read-only'])('refuses an unavailable target: %s', async kind => {
    if (kind === 'cell') await h.db.execute("UPDATE workspaces SET properties_migration = 'cell' WHERE id = 'ws'")
    if (kind === 'deleted owner') await repo.tx(tx => tx.delete('owner'), {scope: ChangeScope.BlockDefault})
    if (kind === 'read-only') Object.defineProperty(repo, 'isReadOnly', {value: true})
    const before = await h.db.getAll('SELECT * FROM blocks ORDER BY id')
    await expect(selectInlineProperty(repo.block(kind === 'missing owner' ? 'absent' : 'owner'), note,
      repo.block(kind === 'missing source' ? 'absent' : 'source'))).rejects.toThrow()
    expect(await h.db.getAll('SELECT * FROM blocks ORDER BY id')).toEqual(before)
  })

  it.each(['content', 'children', 'properties', 'moved', 'deleted'])('refuses a source changed while the picker was open: %s', async kind => {
    if (kind === 'content') await repo.block('source').setContent('keep this')
    if (kind === 'children') await repo.mutate.createChild({parentId: 'source', content: 'keep child'})
    if (kind === 'properties') {
      await h.db.writeTransaction(tx => tx.execute(
        'UPDATE blocks SET properties_json = ? WHERE id = ?', [JSON.stringify({'test:note': 'keep property'}), 'source']))
      expect(await children('source')).toEqual([])
    }
    if (kind === 'moved') await repo.tx(tx => tx.move('source', {parentId: null, orderKey: 'a1'}), {scope: ChangeScope.BlockDefault})
    if (kind === 'deleted') await repo.tx(tx => tx.delete('source'), {scope: ChangeScope.BlockDefault})
    const before = await h.db.getAll('SELECT * FROM blocks ORDER BY id')
    await expect(selectInlineProperty(repo.block('owner'), note, repo.block('source'))).rejects.toThrow()
    expect(await h.db.getAll('SELECT * FROM blocks ORDER BY id')).toEqual(before)
  })
})
