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
import {projectFieldRowValues} from '@/data/internals/propertyChildrenProcessor'
import {encodedToValueChildContent} from '@/data/propertyChildren'
import {pasteEditModeMultilineText, planEditModeMultilinePaste} from '@/paste/operations'
import {findReplaceDataExtension, FIND_REPLACE_APPLY_CONTENT_REPLACE_MUTATOR} from '@/plugins/find-replace/dataExtension'

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
  repo = createTestRepo({db: db.db, extensions: [referencesDataExtension, aliasDataExtension, findReplaceDataExtension]}).repo
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

  it.each(['paste', 'merge', 'find-replace', 'raw update'])('refuses a grammar-shaped name at projection from %s', async writer => {
    const original = writer === 'merge' ? '[[O' : 'original'
    const valueId = await fixture(original)
    if (writer === 'merge') await repo.block('unrelated').setContent('ther]]')
    const before = await db.db.getAll('SELECT * FROM blocks ORDER BY id')
    const write = () => {
      if (writer === 'paste') {
        const plan = planEditModeMultilinePaste('- [[Other]]\n- tail', original, {from: 0, to: original.length})!
        expect(plan.targetContent).toBe('[[Other]]')
        return pasteEditModeMultilineText(plan, repo.block(valueId), repo)
      }
      if (writer === 'merge') return repo.mutate.merge({intoId: valueId, fromId: 'unrelated', contentStrategy: 'concat'})
      if (writer === 'find-replace') return repo.run(FIND_REPLACE_APPLY_CONTENT_REPLACE_MUTATOR, {
        workspaceId: WS, find: original, replace: '[[Other]]', options: {matchCase: true, wholeWord: false},
        items: [{blockId: valueId, originalContent: original}],
      })
      return repo.tx(tx => tx.update(valueId, {content: '[[Other]]'}), {scope: ChangeScope.BlockDefault})
    }
    await expect(write().then(() => undefined)).rejects.toThrow(/reference|grammar/i)
    expect(await db.db.getAll('SELECT * FROM blocks ORDER BY id')).toEqual(before)
  })

  it('refuses a changed legacy name atomically instead of leaving its row and cell divergent', async () => {
    const valueId = await fixture()
    await expect(repo.tx(async tx => {
      await tx.update(valueId, {content: '[[Other]]'})
      await tx.update('unrelated', {content: 'after'})
    }, {scope: ChangeScope.BlockDefault})).rejects.toThrow(/reference|grammar/i)
    expect(await storedName()).toBe('[[Old]]')
    expect((await db.db.get<{content: string}>('SELECT content FROM blocks WHERE id = ?', [valueId])).content).toBe('[[Old]]')
    expect((await repo.block('unrelated').load())?.content).toBe('before')
  })

  it('refuses a reference rewrite that would change a legacy name rather than keeping divergent text', async () => {
    const valueId = await fixture()
    await expect(repo.tx(tx => tx.setProperty('page', aliasesProp, ['New']), {scope: ChangeScope.BlockDefault}))
      .rejects.toThrow(/reference|grammar/i)
    expect((await db.db.get<{content: string}>('SELECT content FROM blocks WHERE id = ?', [valueId])).content)
      .toBe('[[Old]]')
    expect(await storedName()).toBe('[[Old]]')
    expect(await repo.block('page').get(aliasesProp)).toEqual(['Old'])
  })
})

describe('property-name projection contract', () => {
  const rows = [[{id: 'value', content: '[[Other]]'}]]
  it('refuses a grammar-shaped projection over a different stored name without a writer', () => {
    expect(() => projectFieldRowValues(propertyNameProp, rows, 'original')).toThrow(/reference|grammar/i)
  })
  it('accepts exactly the unchanged legacy name', () => {
    expect(projectFieldRowValues(propertyNameProp, rows, '[[Other]]')).toBe('[[Other]]')
  })
  it('does not apply the name rule to ordinary string properties', () => {
    expect(projectFieldRowValues({...propertyNameProp, name: 'ordinary'}, rows, 'original')).toBe('[[Other]]')
  })
  it('allows an empty name field to unset its cell', () => {
    expect(projectFieldRowValues(propertyNameProp, [[]], 'original')).toBeUndefined()
  })
})
