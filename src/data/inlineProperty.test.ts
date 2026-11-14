import {afterAll, beforeAll, beforeEach, describe, expect, it, vi} from 'vitest'
import {presetIdProp, propertyChangeScopeProp} from '@/data/properties'
import {getOrCreatePropertiesPage} from '@/data/propertiesPage'
import {ChangeScope} from '@/data/api'
import {definitionSeedsFacet} from '@/data/facets'
import {seedProperty} from '@/data/propertySeeds'
import {createTestDb, resetTestDb, type TestDb} from '@/data/test/createTestDb'
import {createTestRepo} from '@/data/test/createTestRepo'
import type {Repo} from '@/data/repo'
import {selectInlineProperty, commitInlineProperty} from '@/data/inlineProperty'

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

  it('keeps selection and commit under a non-undoable definition policy', async () => {
    const selected = await selectInlineProperty(repo.block('owner'), preference, repo.block('source'))
    await commitInlineProperty(repo.block('owner'), selected, 'saved preference')
    expect(repo.undoManager.depths(ChangeScope.BlockDefault).undo).toBe(0)
    expect(await repo.undo()).toBe(false)
    expect(await h.db.getOptional("SELECT id FROM blocks WHERE id = 'source' AND deleted = 0")).toBeNull()
    expect(await repo.block('owner').get(preference)).toBe('saved preference')
  })

  it.each([false, true])('chooses a free order key at the scaffold position after an intervening insert: collision %s', async collision => {
    const selected = await selectInlineProperty(repo.block('owner'), note, repo.block('source'))
    await repo.tx(async tx => {
      if (collision) await tx.create({id: 'intervening', workspaceId: 'ws', parentId: 'owner', orderKey: selected.orderKey!, content: 'keep sibling'})
      await tx.create({id: 'after', workspaceId: 'ws', parentId: 'owner', orderKey: 'a2', content: 'later sibling'})
    }, {scope: ChangeScope.BlockDefault})
    const target = await commitInlineProperty(repo.block('owner'), selected, 'value')
    const rows = await children('owner')
    expect(new Set(rows.map(row => row.orderKey)).size).toBe(rows.length)
    expect(rows.map(row => row.id)).toEqual(collision ? ['intervening', target!.fieldRowId, 'after'] : [target!.fieldRowId, 'after'])
    if (!collision) expect(rows[0]?.orderKey).toBe(selected.orderKey)
  })

  it.each(['select', 'commit'])('refuses a stale list definition scope before %s can write', async stage => {
    await getOrCreatePropertiesPage(repo, 'ws')
    const mutable = await repo.userSchemas.addSchema({name: 'scoped list', presetId: 'string-list'})
    const selected = stage === 'commit' ? await selectInlineProperty(repo.block('owner'), mutable, repo.block('source')) : undefined
    await repo.block(mutable.fieldId).set(propertyChangeScopeProp, ChangeScope.UserPrefs)
    await vi.waitFor(() => expect(repo.propertySchemas.get(mutable.name)?.changeScope).toBe(ChangeScope.UserPrefs))
    const before = await h.db.getAll('SELECT * FROM blocks ORDER BY id')
    await expect(stage === 'select' ? selectInlineProperty(repo.block('owner'), mutable, repo.block('source')) :
      commitInlineProperty(repo.block('owner'), selected!, 'new member')).rejects.toThrow(/scope/)
    expect(await h.db.getAll('SELECT * FROM blocks ORDER BY id')).toEqual(before)
  })

  it('reports a friendly property-specific refusal for undecodable text', async () => {
    await getOrCreatePropertiesPage(repo, 'ws')
    const numeric = await repo.userSchemas.addSchema({name: 'count', presetId: 'optional-number'})
    const selected = await selectInlineProperty(repo.block('owner'), numeric)
    await expect(commitInlineProperty(repo.block('owner'), selected, 'not a number'))
      .rejects.toThrow('Enter a valid value for count. Your draft was kept.')
    expect(await repo.block('owner').get(numeric)).toBeUndefined()
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

  it('a stale list draft does not replace a scalar value after a preset change', async () => {
    await getOrCreatePropertiesPage(repo, 'ws')
    const mutable = await repo.userSchemas.addSchema({name: 'mutable', presetId: 'string-list'})
    const selected = await selectInlineProperty(repo.block('owner'), mutable, repo.block('source'))
    await repo.block(mutable.fieldId).set(presetIdProp, 'json')
    await vi.waitFor(() => expect(repo.propertySchemas.get('mutable')?.codec.type).toBe('object'))
    const current = repo.propertySchemas.get('mutable')!
    await repo.block('owner').set(current, {keep: 'stored object'})
    const before = await h.db.getAll('SELECT * FROM blocks ORDER BY id')
    await expect(commitInlineProperty(repo.block('owner'), selected, 'new draft')).rejects.toThrow()
    expect(await repo.block('owner').get(current)).toEqual({keep: 'stored object'})
    expect(await h.db.getAll('SELECT * FROM blocks ORDER BY id')).toEqual(before)
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

  it.each(['lagging member', 'duplicate fields without a cell'])('appends from live rows without changing existing members: %s', async setup => {
    await repo.block('owner').set(tags, [setup === 'lagging member' ? 'a' : 'one'])
    const selected = await selectInlineProperty(repo.block('owner'), tags, repo.block('source'))
    const first = (await children(selected.fieldRowId!))[0]!
    await h.db.writeTransaction(async tx => {
      const insert = (id: string, parentId: string, orderKey: string, content: string, fieldId: string | null = null) => tx.execute(
        `INSERT INTO blocks (id, workspace_id, parent_id, order_key, content, properties_json,
          reference_target_id, is_field_form, deleted, created_at, updated_at, user_updated_at, created_by, updated_by)
         VALUES (?, 'ws', ?, ?, ?, '{}', ?, ?, 0, 1, 1, 1, 'user', 'user')`,
        [id, parentId, orderKey, content, fieldId, fieldId ? 1 : 0])
      if (setup === 'duplicate fields without a cell') {
        await insert('second-field', 'owner', 'a2', `::((${selected.schema.fieldId}))`, selected.schema.fieldId)
        await tx.execute("UPDATE blocks SET properties_json = '{}' WHERE id = 'owner'")
      }
      await insert('arrived-member', setup === 'lagging member' ? selected.fieldRowId! : 'second-field',
        'a2', setup === 'lagging member' ? 'from other device' : 'two')
      await insert('nested-note', 'arrived-member', 'a0', 'keep nested note')
    })
    const held = () => h.db.getAll<{id: string; deleted: number}>(
      `SELECT id, parent_id, order_key, content, properties_json, deleted FROM blocks
       WHERE id IN (?, ?, 'second-field', 'arrived-member', 'nested-note') ORDER BY id`, [selected.fieldRowId!, first.id])
    const before = await held()
    const count = (await h.db.get<{n: number}>('SELECT COUNT(*) AS n FROM blocks WHERE deleted = 0')).n
    expect(before.every(row => row.deleted === 0)).toBe(true)
    const bag = JSON.parse((await h.db.get<{properties_json: string}>("SELECT properties_json FROM blocks WHERE id = 'owner'")).properties_json)
    expect(bag[tags.name]).toEqual(setup === 'lagging member' ? ['a'] : undefined)
    repo.undoManager.clear()

    const target = await commitInlineProperty(repo.block('owner'), selected, 'new')

    expect(await held()).toEqual(before)
    expect((await h.db.get<{n: number}>('SELECT COUNT(*) AS n FROM blocks WHERE deleted = 0')).n).toBe(count + 1)
    expect(await repo.block('owner').get(tags)).toEqual(setup === 'lagging member' ? ['a', 'from other device', 'new'] : ['one', 'two', 'new'])
    expect((await children(target!.fieldRowId)).at(-1)?.id).toBe(target!.valueId)
    expect(repo.undoManager.depths(ChangeScope.BlockDefault).undo).toBe(1)
    await repo.undo()
    expect(await held()).toEqual(before)
    expect(await h.db.getOptional('SELECT id FROM blocks WHERE id = ? AND deleted = 0', [target!.valueId])).toBeNull()
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

  it.each(['value row', 'stored cell'])('refuses a scalar draft when a %s appears after selection', async kind => {
    const selection = await selectInlineProperty(repo.block('owner'), note)
    if (kind === 'value row') {
      await repo.block('owner').set(note, 'existing')
      await h.db.writeTransaction(tx => tx.execute('UPDATE blocks SET properties_json = ? WHERE id = ?', ['{}', 'owner']))
      const field = (await children('owner')).find(row => row.isFieldForm)!
      expect(await children(field.id)).toHaveLength(1)
    } else {
      await h.db.writeTransaction(tx => tx.execute('UPDATE blocks SET properties_json = ? WHERE id = ?',
        [JSON.stringify({[note.name]: 'existing'}), 'owner']))
      expect((await children('owner')).some(row => row.isFieldForm)).toBe(false)
    }
    const before = await h.db.getAll('SELECT * FROM blocks ORDER BY id')
    await expect(commitInlineProperty(repo.block('owner'), selection, 'draft')).rejects.toThrow('This property now has a value.')
    expect(await h.db.getAll('SELECT * FROM blocks ORDER BY id')).toEqual(before)
  })

  it.each(['read-only', 'cell', 'missing owner', 'deleted owner'])('refuses a draft whose target became unavailable: %s', async kind => {
    const selection = await selectInlineProperty(repo.block('owner'), note)
    if (kind === 'read-only') Object.defineProperty(repo, 'isReadOnly', {value: true})
    if (kind === 'cell') await h.db.execute("UPDATE workspaces SET properties_migration = 'cell' WHERE id = 'ws'")
    if (kind === 'deleted owner') await repo.tx(tx => tx.delete('owner'), {scope: ChangeScope.BlockDefault})
    const before = await h.db.getAll('SELECT * FROM blocks ORDER BY id')
    const tx = vi.spyOn(repo, 'tx')
    await expect(commitInlineProperty(repo.block(kind === 'missing owner' ? 'absent' : 'owner'), selection, 'draft')).rejects.toThrow(
      kind === 'read-only' ? 'This workspace is read-only.' : 'This block no longer supports properties in the outline.')
    if (kind === 'read-only') expect(tx).not.toHaveBeenCalled()
    expect(await h.db.getAll('SELECT * FROM blocks ORDER BY id')).toEqual(before)
    tx.mockRestore()
  })

  it.each(['cell', 'missing owner', 'deleted owner', 'missing source', 'read-only'])('refuses an unavailable target: %s', async kind => {
    if (kind === 'cell') await h.db.execute("UPDATE workspaces SET properties_migration = 'cell' WHERE id = 'ws'")
    if (kind === 'deleted owner') await repo.tx(tx => tx.delete('owner'), {scope: ChangeScope.BlockDefault})
    if (kind === 'read-only') Object.defineProperty(repo, 'isReadOnly', {value: true})
    const before = await h.db.getAll('SELECT * FROM blocks ORDER BY id')
    await expect(selectInlineProperty(repo.block(kind === 'missing owner' ? 'absent' : 'owner'), note,
      repo.block(kind === 'missing source' ? 'absent' : 'source'))).rejects.toThrow(
        kind === 'read-only' ? 'This workspace is read-only.' : kind === 'missing source' ? 'The input block changed.' : 'This block no longer supports properties in the outline.')
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
    await expect(selectInlineProperty(repo.block('owner'), note, repo.block('source'))).rejects.toThrow('The input block changed.')
    expect(await h.db.getAll('SELECT * FROM blocks ORDER BY id')).toEqual(before)
  })
})
