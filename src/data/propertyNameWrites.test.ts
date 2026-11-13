// @vitest-environment node
import {afterAll, beforeAll, beforeEach, describe, expect, it} from 'vitest'
import {ChangeScope, type BlockData} from '@/data/api'
import {createTestDb, resetTestDb, type TestDb} from '@/data/test/createTestDb'
import {createTestRepo} from '@/data/test/createTestRepo'
import {aliasesProp, propertyNameProp} from '@/data/properties'
import {propertyDefinitionBlockId} from '@/data/definitionSeeds'
import {referencesDataExtension} from '@/plugins/references/dataExtension'
import {aliasDataExtension} from '@/plugins/alias/dataExtension'
import {serializeBlock} from '@/utils/copy'
import type {Repo} from '@/data/repo'
import {setContent} from '@/data/mutators'
import {encodedToValueChildContent} from '@/data/propertyChildren'

const WS = 'test-name-writes'
let db: TestDb
let repo: Repo
beforeAll(async () => { db = await createTestDb() })
afterAll(async () => { await db.cleanup() })
beforeEach(async () => {
  await resetTestDb(db.db)
  await db.db.execute(`INSERT INTO workspaces
    (id, name, owner_user_id, create_time, update_time, encryption_mode, properties_migration)
    VALUES (?, 'test', 'user', 1, 1, 'none', 'children')`, [WS])
  repo = createTestRepo({db: db.db, extensions: [referencesDataExtension, aliasDataExtension]}).repo
  repo.setActiveWorkspaceId(WS)
})

const nameValue = async (): Promise<BlockData> => {
  const field = (await repo.query.children({id: 'definition', propertyChildren: 'all'}).load())!
    .find(row => row.referenceTargetId === propertyDefinitionBlockId(WS, propertyNameProp.seedKey!))!
  return (await repo.query.children({id: field.id, propertyChildren: 'all'}).load())![0]!
}

const fixture = async (legacy = '[[Old]]') => {
  await repo.tx(async tx => {
    await tx.create({id: 'page', workspaceId: WS, parentId: null, orderKey: 'a0', content: 'Old'})
    await tx.setProperty('page', aliasesProp, ['Old'])
    await tx.create({id: 'definition', workspaceId: WS, parentId: null, orderKey: 'a1',
      content: 'definition', properties: {types: ['property-schema'],
        'property-schema:preset': 'string', [propertyNameProp.name]: 'original'}})
    await tx.create({id: 'unrelated', workspaceId: WS, parentId: null, orderKey: 'a2', content: 'before'})
  }, {scope: ChangeScope.BlockDefault})
  const value = await nameValue()
  const original = (await repo.block('definition').load())!
  // A synced legacy row, before any local projection can rewrite its name.
  await db.db.writeTransaction(async tx => {
    await tx.execute('UPDATE blocks SET properties_json = ? WHERE id = ?',
      [JSON.stringify({...original.properties, [propertyNameProp.name]: legacy}), 'definition'])
    await tx.execute('UPDATE blocks SET content = ?, references_json = ? WHERE id = ?',
      [legacy, JSON.stringify([{id: 'page', alias: 'Old'}]), value.id])
  })
  return value.id
}

const storedName = async () => JSON.parse((await db.db.get<{properties_json: string}>(
  'SELECT properties_json FROM blocks WHERE id = ?', ['definition'])).properties_json)[propertyNameProp.name]

describe('legacy property names at user write boundaries', () => {
  it('copies a raw legacy name and creates a duplicate carrying it unchanged', async () => {
    await fixture()
    const copied = await serializeBlock(repo.block('definition'), 'all')
    expect(copied.blocks[0]!.properties[propertyNameProp.name]).toBe('[[Old]]')
    await repo.tx(tx => tx.create({...copied.blocks[0]!, id: 'duplicate', parentId: null, orderKey: 'b0'}),
      {scope: ChangeScope.BlockDefault})
    expect(await repo.block('duplicate').get(propertyNameProp)).toBe('[[Old]]')
    expect(await storedName()).toBe('[[Old]]')
  })

  it('refuses a user edit of a legacy name value before changing its row', async () => {
    const valueId = await fixture()
    await expect(repo.block(valueId).setContent('[[Other]]')).rejects.toThrow(/reference|grammar/i)
    expect((await db.db.get<{content: string}>('SELECT content FROM blocks WHERE id = ?', [valueId])).content)
      .toBe('[[Old]]')
    expect(await storedName()).toBe('[[Old]]')
  })

  it('refuses an escaped grammar-shaped name without rolling back other edits in the transaction', async () => {
    const valueId = await fixture()
    const content = encodedToValueChildContent(propertyNameProp, '::[[Other]]')
    expect(content).not.toBe('::[[Other]]')
    await repo.tx(async tx => {
      await tx.update('unrelated', {content: 'after'})
      await expect(tx.run(setContent, {id: valueId, content})).rejects.toThrow(/reference|grammar/i)
    }, {scope: ChangeScope.BlockDefault})
    expect(await storedName()).toBe('[[Old]]')
    expect((await repo.block('unrelated').load())?.content).toBe('after')
  })

  it('allows ordinary reference content and an unchanged legacy name', async () => {
    const valueId = await fixture()
    await repo.block('unrelated').setContent('[[Other]]')
    await repo.block(valueId).setContent('[[Old]]')
    expect((await repo.block('unrelated').load())?.content).toBe('[[Other]]')
    expect(await storedName()).toBe('[[Old]]')
  })

  it('keeps the stored name when projection sees a refused value and commits unrelated writes', async () => {
    const valueId = await fixture()
    await repo.tx(async tx => {
      await tx.update(valueId, {content: '[[Other]]'})
      await tx.update('unrelated', {content: 'after'})
    }, {scope: ChangeScope.BlockDefault})
    expect(await storedName()).toBe('[[Old]]')
    expect((await repo.block('unrelated').load())?.content).toBe('after')
  })

  it('renames a referenced page without aborting or renaming the legacy definition', async () => {
    const valueId = await fixture()
    await repo.tx(tx => tx.setProperty('page', aliasesProp, ['New']), {scope: ChangeScope.BlockDefault})
    expect((await db.db.get<{content: string}>('SELECT content FROM blocks WHERE id = ?', [valueId])).content)
      .toBe('[[New]]')
    expect(await storedName()).toBe('[[Old]]')
    expect(await repo.block('page').get(aliasesProp)).toEqual(['New'])
  })
})
