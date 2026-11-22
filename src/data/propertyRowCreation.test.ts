import {afterAll, beforeAll, beforeEach, describe, expect, it, vi} from 'vitest'
import {ChangeScope} from '@/data/api'
import {Block} from '@/data/block'
import {definitionSeedsFacet} from '@/data/facets'
import {propertyChangeScopeProp} from '@/data/properties'
import {getOrCreatePropertiesPage} from '@/data/propertiesPage'
import {seedProperty} from '@/data/propertySeeds'
import {createTestDb, resetTestDb, type TestDb} from '@/data/test/createTestDb'
import {createTestRepo} from '@/data/test/createTestRepo'
import type {Repo} from '@/data/repo'
import {choosePropertyField, createPropertyField} from '@/data/propertyRowCreation'

const note = seedProperty({seedKey: 'test/property/note', revision: 1, name: 'test:note', preset: 'string', changeScope: ChangeScope.BlockDefault})
const preference = seedProperty({seedKey: 'test/property/preference', revision: 1, name: 'test:preference', preset: 'string', changeScope: ChangeScope.UserPrefs})
const tags = seedProperty({seedKey: 'test/property/tags', revision: 1, name: 'test:tags', preset: 'string-list', changeScope: ChangeScope.BlockDefault})
let h: TestDb
let repo: Repo
beforeAll(async () => { h = await createTestDb() })
afterAll(async () => { await h.cleanup() })
beforeEach(async () => {
  await resetTestDb(h.db)
  repo = createTestRepo({db: h.db, newId: () => crypto.randomUUID(), extensions: [definitionSeedsFacet.of(note), definitionSeedsFacet.of(tags), definitionSeedsFacet.of(preference)]}).repo
  repo.setActiveWorkspaceId('ws')
  await h.db.execute("INSERT INTO workspaces (id, name, owner_user_id, create_time, update_time, encryption_mode, properties_migration) VALUES ('ws', 'Test', 'user', 1, 1, 'none', 'children')")
  await repo.tx(async tx => {
    await tx.create({id: 'owner', workspaceId: 'ws', parentId: null, orderKey: 'a0', content: 'Owner'})
    await tx.create({id: 'source', workspaceId: 'ws', parentId: 'owner', orderKey: 'a0', content: '::'})
  }, {scope: ChangeScope.BlockDefault})
  repo.undoManager.clear()
})
const children = (id: string) => repo.query.children({id, propertyChildren: 'all'}).load()

describe('property rows created as blocks', () => {
  it.each(['accepted', 'changed scaffold', 'changed editor'])('creates a definition atomically with a validated scaffold: %s', async kind => {
    await getOrCreatePropertiesPage(repo, 'ws')
    repo.undoManager.clear()
    if (kind === 'changed scaffold') await repo.block('source').setContent('keep text')
    const before = await h.db.getAll('SELECT * FROM blocks ORDER BY id')
    const create = createPropertyField(repo.block('owner'), repo.block('source'), 'outline new', 'ref', '::', () => kind !== 'changed editor')
    if (kind !== 'accepted') {
      await expect(create).rejects.toThrow('The input block changed.')
      expect(await h.db.getAll('SELECT * FROM blocks ORDER BY id')).toEqual(before)
      expect(repo.propertySchemas.has('outline new')).toBe(false)
    } else {
      const target = await create
      expect((await repo.load('source'))?.content).toBe(`::((${target.schema.fieldId}))`)
      expect(await children('source')).toEqual([])
      expect(repo.undoManager.depths(ChangeScope.BlockDefault).undo).toBe(1)
      await repo.undo()
      expect((await repo.load('source'))?.content).toBe('::')
      await vi.waitFor(() => expect(repo.propertySchemas.has('outline new')).toBe(false))
    }
  })

  it('does not create a definition over a pending cell, including a padded name', async () => {
    await getOrCreatePropertiesPage(repo, 'ws')
    await h.db.writeTransaction(tx => tx.execute('UPDATE blocks SET properties_json = ? WHERE id = ?', [JSON.stringify({'pending field': 'keep'}), 'owner']))
    const before = await h.db.getAll('SELECT * FROM blocks ORDER BY id')
    await expect(createPropertyField(repo.block('owner'), repo.block('source'), ' pending field ', 'ref', '::', () => true)).rejects.toThrow('no longer supports')
    expect(await h.db.getAll('SELECT * FROM blocks ORDER BY id')).toEqual(before)
    expect(repo.propertySchemas.has('pending field')).toBe(false)
  })

  it('adopts a registered definition instead of creating a duplicate through the shared creation path', async () => {
    await getOrCreatePropertiesPage(repo, 'ws')
    await repo.awaitSeedMaterialization()
    const before = await h.db.getAll('SELECT id FROM blocks WHERE parent_id = ? AND deleted = 0 ORDER BY id', [repo.propertiesPageId])
    const result = await createPropertyField(repo.block('owner'), repo.block('source'), note.name, 'string', '::', () => true)
    expect(result.schema.name).toBe(note.name)
    expect((await repo.load('source'))?.isFieldForm).toBe(true)
    expect(await h.db.getAll('SELECT id FROM blocks WHERE parent_id = ? AND deleted = 0 ORDER BY id', [repo.propertiesPageId])).toEqual(before)
    expect(await children('source')).toEqual([])
  })

  it('converts the scaffold in place without an empty value; undo restores the marker', async () => {
    const target = await choosePropertyField(repo.block('owner'), note, repo.block('source'), '::', () => true)
    expect(target.fieldRowId).toBe('source')
    expect((await children('owner')).map(row => row.id)).toEqual(['source'])
    expect(await children('source')).toEqual([])
    expect((await repo.load('source'))?.content).toBe(`::((${target.schema.fieldId}))`)
    expect(repo.undoManager.depths(ChangeScope.BlockDefault).undo).toBe(1)
    await repo.undo()
    expect((await repo.load('source'))?.content).toBe('::')
    expect(await children('source')).toEqual([])
  })

  it('existing scalar navigation deletes the scaffold and preserves the value', async () => {
    await repo.block('owner').set(note, 'saved')
    const fields = (await children('owner')).filter(row => row.isFieldForm)
    const values = await children(fields[0].id)
    const result = await choosePropertyField(repo.block('owner'), note, repo.block('source'), '::', () => true)
    expect(result.valueId).toBe(values[0].id)
    expect(await h.db.getOptional('SELECT id FROM blocks WHERE id = ? AND deleted = 0', ['source'])).toBeNull()
    expect(await children(fields[0].id)).toEqual(values)
    expect(await repo.block('owner').get(note)).toBe('saved')
  })

  it('existing list selection deletes the scaffold without appending an empty member', async () => {
    await repo.block('owner').set(tags, ['saved'])
    const result = await choosePropertyField(repo.block('owner'), tags, repo.block('source'), '::', () => true)
    expect(result.valueId).toBeUndefined()
    expect(await h.db.getOptional('SELECT id FROM blocks WHERE id = ? AND deleted = 0', ['source'])).toBeNull()
    expect(await repo.block('owner').get(tags)).toEqual(['saved'])
    expect(await children(result.fieldRowId)).toHaveLength(1)
    await repo.mutate.createChild({parentId: result.fieldRowId, content: 'new'})
    expect(await repo.block('owner').get(tags)).toEqual(['saved', 'new'])
    expect(await children(result.fieldRowId)).toHaveLength(2)
  })

  it.each(['lagging member', 'duplicate fields without a stored value'])('appends from live rows without losing a row or note: %s', async setup => {
    await repo.block('owner').set(tags, [setup === 'lagging member' ? 'a' : 'one'])
    const resolution = repo.propertySchemaResolverFor('ws').resolve(tags.name)
    if (resolution.status !== 'resolved') throw new Error('Missing definition')
    const selected = {schema: resolution.schema, fieldRowId: (await children('owner')).find(row => row.isFieldForm)!.id}
    const first = (await children(selected.fieldRowId!))[0]!
    await h.db.writeTransaction(async tx => {
      const insert = (id: string, parentId: string, orderKey: string, content: string, fieldId: string | null = null) => tx.execute(
        `INSERT INTO blocks (id, workspace_id, parent_id, order_key, content, properties_json,
          reference_target_id, is_field_form, deleted, created_at, updated_at, user_updated_at, created_by, updated_by)
         VALUES (?, 'ws', ?, ?, ?, '{}', ?, ?, 0, 1, 1, 1, 'user', 'user')`,
        [id, parentId, orderKey, content, fieldId, fieldId ? 1 : 0])
      if (setup === 'duplicate fields without a stored value') {
        await insert('second-field', 'owner', 'a2', `::((${selected.schema.fieldId}))`, selected.schema.fieldId)
        await tx.execute("UPDATE blocks SET properties_json = '{}' WHERE id = 'owner'")
      }
      await insert('arrived-member', setup === 'lagging member' ? selected.fieldRowId! : 'second-field',
        'a2', setup === 'lagging member' ? 'from other device' : 'two')
      await insert('nested-note', 'arrived-member', 'a0', 'keep nested note')
    })
    const held = () => h.db.getAll<{id: string; deleted: number}>(
      `SELECT id, parent_id, content, properties_json, deleted FROM blocks
       WHERE id IN (?, ?, 'second-field', 'arrived-member', 'nested-note') ORDER BY id`, [selected.fieldRowId!, first.id])
    const before = await held()
    const count = (await h.db.get<{n: number}>('SELECT COUNT(*) AS n FROM blocks WHERE deleted = 0')).n
    expect(before.every(row => row.deleted === 0)).toBe(true)
    const bag = JSON.parse((await h.db.get<{properties_json: string}>("SELECT properties_json FROM blocks WHERE id = 'owner'")).properties_json)
    expect(bag[tags.name]).toEqual(setup === 'lagging member' ? ['a'] : undefined)
    repo.undoManager.clear()

    const target = await repo.undoGroup(async grouped => {
      const choice = await choosePropertyField(new Block(grouped, 'owner'), tags, new Block(grouped, 'source'), '::', () => true)
      const valueId = await grouped.mutate.createChild({parentId: choice.fieldRowId, content: 'new'})
      return {...choice, valueId}
    })

    if (setup === 'lagging member') expect(await held()).toEqual(before)
    else {
      // Opening folds the duplicate field: its member and the member's note move, nothing is re-minted.
      expect((await held()).find(row => row.id === 'second-field')?.deleted).toBe(1)
      expect((await children(selected.fieldRowId)).map(row => row.id)).toContain('arrived-member')
      expect((await children('arrived-member')).map(row => row.id)).toEqual(['nested-note'])
    }
    expect((await h.db.get<{n: number}>('SELECT COUNT(*) AS n FROM blocks WHERE deleted = 0')).n)
      .toBe(setup === 'lagging member' ? count : count - 1)
    expect(await repo.block('owner').get(tags)).toEqual(setup === 'lagging member' ? ['a', 'from other device', 'new'] : ['one', 'two', 'new'])
    expect((await children(target.fieldRowId)).at(-1)?.id).toBe(target.valueId)
    expect(repo.undoManager.depths(ChangeScope.BlockDefault).undo).toBe(1)
    await repo.undo()
    expect(await held()).toEqual(before)
    expect(await h.db.getOptional('SELECT id FROM blocks WHERE id = ? AND deleted = 0', [target.valueId])).toBeNull()
  })

  it.each(['cell', 'missing owner', 'deleted owner', 'missing source', 'read-only'])('refuses an unavailable target: %s', async kind => {
    if (kind === 'cell') await h.db.execute("UPDATE workspaces SET properties_migration = 'cell' WHERE id = 'ws'")
    if (kind === 'deleted owner') await repo.tx(tx => tx.delete('owner'), {scope: ChangeScope.BlockDefault})
    if (kind === 'read-only') Object.defineProperty(repo, 'isReadOnly', {value: true})
    const spy = vi.spyOn(repo, 'tx')
    const before = await h.db.getAll('SELECT * FROM blocks ORDER BY id')
    await expect(choosePropertyField(repo.block(kind === 'missing owner' ? 'absent' : 'owner'), note,
      repo.block(kind === 'missing source' ? 'absent' : 'source'), '::', () => true)).rejects.toThrow(
        ({'read-only': 'This workspace is read-only.', 'missing source': 'The input block changed.', 'missing owner': 'does not exist',
          'deleted owner': 'The property owner is missing or deleted.', cell: 'This workspace does not store properties as rows.'})[kind]!)
    if (kind === 'read-only') expect(spy).not.toHaveBeenCalled()
    spy.mockRestore()
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
    await expect(choosePropertyField(repo.block('owner'), note, repo.block('source'), '::', () => true)).rejects.toThrow('The input block changed.')
    expect(await h.db.getAll('SELECT * FROM blocks ORDER BY id')).toEqual(before)
  })
  it.each([
    {schema: note, stored: 'stored'}, {schema: note, stored: ''},
    {schema: tags, stored: ['stored', 'stored']}, {schema: tags, stored: []},
  ])('materializes a stored value awaiting its field row: $schema.name $stored', async ({schema, stored}) => {
    await h.db.writeTransaction(tx => tx.execute('UPDATE blocks SET properties_json = ? WHERE id = ?',
      [JSON.stringify({[schema.name]: stored, other: 'keep'}), 'owner']))
    const live = () => h.db.getAll('SELECT id, content FROM blocks WHERE deleted = 0 ORDER BY id')
    const before = await live()
    repo.undoManager.clear()

    const result = await choosePropertyField(repo.block('owner'), schema, repo.block('source'), '::', () => true)

    expect(await h.db.getOptional('SELECT id FROM blocks WHERE id = ? AND deleted = 0', ['source'])).toBeNull()
    expect((await children('owner')).map(row => row.id)).toEqual([result.fieldRowId])
    const values = await children(result.fieldRowId)
    expect(values.map(row => row.content)).toEqual(schema === tags ? stored : [stored])
    expect(result.valueId).toBe(schema === tags ? undefined : values[0]!.id)
    expect(JSON.parse((await h.db.get<{properties_json: string}>("SELECT properties_json FROM blocks WHERE id = 'owner'")).properties_json))
      .toEqual({[schema.name]: stored, other: 'keep'})
    await repo.undo()
    expect(await live()).toEqual(before)
  })

  it.each([
    {schema: note, stored: 'z', rows: [['x'], ['y']]},
    {schema: tags, stored: ['a', 'b'], rows: [['a'], ['a']]},
  ])('refuses to fold duplicate field rows that disagree with the stored value: $schema.name', async ({schema, stored, rows}) => {
    const resolution = repo.propertySchemaResolverFor('ws').resolve(schema.name)
    if (resolution.status !== 'resolved') throw new Error('Missing definition')
    const definition = resolution.schema.fieldId
    await h.db.writeTransaction(async tx => {
      const insert = (id: string, parentId: string, content: string, fieldId: string | null = null) => tx.execute(
        `INSERT INTO blocks (id, workspace_id, parent_id, order_key, content, properties_json,
          reference_target_id, is_field_form, deleted, created_at, updated_at, user_updated_at, created_by, updated_by)
         VALUES (?, 'ws', ?, 'a1', ?, '{}', ?, ?, 0, 1, 1, 1, 'user', 'user')`,
        [id, parentId, content, fieldId, fieldId ? 1 : 0])
      for (const [index, values] of rows.entries()) {
        await insert(`field-${index}`, 'owner', `::((${definition}))`, definition)
        for (const value of values) await insert(`field-${index}-${value}`, `field-${index}`, value)
      }
      await tx.execute('UPDATE blocks SET properties_json = ? WHERE id = ?', [JSON.stringify({[schema.name]: stored}), 'owner'])
    })
    const before = await h.db.getAll('SELECT * FROM blocks ORDER BY id')
    await expect(choosePropertyField(repo.block('owner'), schema, repo.block('source'), '::', () => true)).rejects.toThrow(/would change its stored value/)
    expect(await h.db.getAll('SELECT * FROM blocks ORDER BY id')).toEqual(before)
  })

  it('refuses a stored value that cannot be materialized unchanged, before touching the scaffold', async () => {
    await h.db.writeTransaction(tx => tx.execute('UPDATE blocks SET properties_json = ? WHERE id = ?',
      [JSON.stringify({[tags.name]: ['ok', 5]}), 'owner']))
    const before = await h.db.getAll('SELECT * FROM blocks ORDER BY id')
    await expect(choosePropertyField(repo.block('owner'), tags, repo.block('source'), '::', () => true)).rejects.toThrow(/without changing it/)
    expect(await h.db.getAll('SELECT * FROM blocks ORDER BY id')).toEqual(before)
  })

  it('refuses stale definition scope before touching the scaffold', async () => {
    await getOrCreatePropertiesPage(repo, 'ws')
    const schema = await repo.userSchemas.addSchema({name: 'mutable', presetId: 'string'})
    await repo.block(schema.fieldId).set(propertyChangeScopeProp, ChangeScope.UserPrefs)
    await vi.waitFor(() => expect(repo.propertySchemas.get('mutable')?.changeScope).toBe(ChangeScope.UserPrefs))
    const before = await h.db.getAll('SELECT * FROM blocks ORDER BY id')
    await expect(choosePropertyField(repo.block('owner'), schema, repo.block('source'), '::', () => true)).rejects.toThrow(/scope/)
    expect(await h.db.getAll('SELECT * FROM blocks ORDER BY id')).toEqual(before)
  })
  it('only reuses a marked row for the chosen definition', async () => {
    await repo.block('owner').set(tags, ['keep'])
    const resolution = repo.propertySchemaResolverFor('ws').resolve(note.name)
    if (resolution.status !== 'resolved') throw new Error('Missing definition')
    await repo.tx(tx => tx.create({id: 'plain-ref', workspaceId: 'ws', parentId: 'owner', orderKey: 'a2',
      content: `((${resolution.schema.fieldId}))`}), {scope: ChangeScope.BlockDefault})
    const before = await h.db.getAll("SELECT * FROM blocks WHERE id = 'plain-ref'")
    const target = await choosePropertyField(repo.block('owner'), note, repo.block('source'), '::', () => true)
    expect(target.fieldRowId).toBe('source')
    expect(await h.db.getAll("SELECT * FROM blocks WHERE id = 'plain-ref'")).toEqual(before)
    expect(await repo.block('owner').get(tags)).toEqual(['keep'])
  })

})
