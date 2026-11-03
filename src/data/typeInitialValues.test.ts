// @vitest-environment node
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { ChangeScope, propertyValue, seedProperty, seedType } from '@/data/api'
import { propertyDefinitionBlockId } from '@/data/definitionSeeds'
import { definitionSeedsFacet, sameTxProcessorsFacet, typeSeedsFacet } from '@/data/facets'
import { typesProp } from '@/data/properties'
import { typeInitialValuesProcessor, withAbsentPropertyValues } from '@/data/typeInitialValues'
import { createTestDb, resetTestDb, type TestDb } from '@/data/test/createTestDb'
import { createTestRepo } from '@/data/test/createTestRepo'
import type { Repo } from '@/data/repo'
import type { Tx } from '@/data/api'

const WS = 'ws-type-initial-values'

const stageProp = seedProperty({
  seedKey: 'plugin:test/property/stage',
  revision: 1,
  name: 'test:stage',
  preset: 'strict-enum',
  config: {options: [
    {value: 'draft', label: 'draft'},
    {value: 'review', label: 'review'},
    {value: 'final', label: 'final'},
  ]},
  defaultValue: 'final',
  changeScope: ChangeScope.BlockDefault,
})

const targetProp = seedProperty({
  seedKey: 'plugin:test/property/target',
  revision: 1,
  name: 'test:target',
  preset: 'optional-number',
  defaultValue: undefined,
  changeScope: ChangeScope.BlockDefault,
})

const essayType = seedType({
  seedKey: 'plugin:test/type/essay',
  revision: 1,
  id: 'test-essay',
  label: 'Essay',
  properties: [stageProp, targetProp],
})

const extension = [
  typeSeedsFacet.of(essayType, {source: 'test'}),
  sameTxProcessorsFacet.of(typeInitialValuesProcessor(essayType.id, [
    propertyValue(stageProp, 'draft'),
    propertyValue(targetProp, 1000),
  ]), {source: 'test'}),
  [stageProp, targetProp].map(prop => definitionSeedsFacet.of(prop, {source: 'test'})),
]

const BLOCK = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb1'

let sharedDb: TestDb
let repo: Repo
beforeAll(async () => { sharedDb = await createTestDb() })
afterAll(async () => { await sharedDb.cleanup() })
beforeEach(async () => {
  await resetTestDb(sharedDb.db)
  repo = createTestRepo({db: sharedDb.db, user: {id: 'user-1'}, extensions: [extension]}).repo
  repo.setActiveWorkspaceId(WS)
})

const createBlock = async (properties: Record<string, unknown> = {}) => {
  await repo.tx(async tx => {
    await tx.create({id: BLOCK, workspaceId: WS, parentId: null, orderKey: 'a0', properties})
  }, {scope: ChangeScope.BlockDefault})
  return repo.block(BLOCK)
}

const stored = () => repo.block(BLOCK).peek()!.properties

describe('typeInitialValuesProcessor', () => {
  it('are written when addType first tags a block', async () => {
    const block = await createBlock()
    await repo.addType(BLOCK, essayType.id)
    expect(block.get(stageProp)).toBe('draft')
    expect(block.get(targetProp)).toBe(1000)
  })

  it('yield to values the addType caller passes', async () => {
    const block = await createBlock()
    await repo.addType(BLOCK, essayType.id, {[stageProp.name]: 'review'})
    expect(block.get(stageProp)).toBe('review')
    expect(block.get(targetProp)).toBe(1000)
  })

  it('never overwrite a value already stored on the block, an explicit null included', async () => {
    await createBlock({[stageProp.name]: 'final', [targetProp.name]: null})
    await repo.addType(BLOCK, essayType.id)
    expect(stored()[stageProp.name]).toBe('final')
    expect(stored()[targetProp.name]).toBeNull()
  })

  it('are written for a membership write that bypasses addType', async () => {
    await createBlock()
    await repo.tx(async tx => {
      await tx.update(BLOCK, {properties: {[typesProp.name]: typesProp.codec.encode([essayType.id])}})
    }, {scope: ChangeScope.BlockDefault})
    expect(stored()[stageProp.name]).toBe('draft')
  })

  it('are written for a block created already tagged', async () => {
    await createBlock({[typesProp.name]: typesProp.codec.encode([essayType.id])})
    expect(stored()[stageProp.name]).toBe('draft')
  })

  it('are not re-applied while the block keeps the type', async () => {
    const block = await createBlock()
    await repo.addType(BLOCK, essayType.id)
    await repo.tx(async tx => { await tx.unsetProperty(BLOCK, targetProp) }, {scope: ChangeScope.BlockDefault})
    await repo.addType(BLOCK, essayType.id)
    await block.set(stageProp, 'review')
    expect(stored()).not.toHaveProperty(targetProp.name)
  })

  it('leave a value the same tx explicitly unset unset', async () => {
    await createBlock()
    await repo.tx(async tx => {
      await repo.addTypeInTx(tx, BLOCK, essayType.id)
      await tx.unsetProperty(BLOCK, targetProp)
    }, {scope: ChangeScope.BlockDefault})
    expect(stored()[stageProp.name]).toBe('draft')
    expect(stored()).not.toHaveProperty(targetProp.name)
  })

  it('leave a property edit to a block with a malformed types cell alone', async () => {
    await createBlock()
    await sharedDb.db.writeTransaction(async db => {
      await db.execute('UPDATE blocks SET properties_json = ? WHERE id = ?', [
        JSON.stringify({[typesProp.name]: 'not-a-list'}), BLOCK,
      ])
    })
    await repo.block(BLOCK).load()
    await repo.block(BLOCK).set(targetProp, 5)
    expect(stored()[targetProp.name]).toBe(5)
  })

  it('reach the property field rows in a workspace that stores properties as child blocks', async () => {
    await resetTestDb(sharedDb.db)
    await sharedDb.db.execute(`INSERT INTO workspaces
      (id, name, owner_user_id, create_time, update_time, encryption_mode, wk_canary, properties_migration)
      VALUES (?, 'Test', 'user-1', 1, 1, 'none', NULL, 'children')`, [WS])
    repo = createTestRepo({
      db: sharedDb.db, user: {id: 'user-1'}, extensions: [extension], appGenerators: true,
    }).repo
    repo.setActiveWorkspaceId(WS)
    await createBlock()
    await repo.addType(BLOCK, essayType.id)
    await repo.awaitProcessors()

    const fieldIds = await sharedDb.db.getAll<{reference_target_id: string}>(
      'SELECT reference_target_id FROM blocks WHERE parent_id = ? AND is_field_form = 1 AND deleted = 0',
      [BLOCK])
    expect(fieldIds.map(row => row.reference_target_id)).toEqual(expect.arrayContaining([
      propertyDefinitionBlockId(WS, stageProp.seedKey),
      propertyDefinitionBlockId(WS, targetProp.seedKey),
    ]))
  })
})

describe('withAbsentPropertyValues', () => {
  // A handle to a renamed definition resolves to the definition's current name.
  const renamingTx = {
    resolvePropertySchema: async (_id: string, schema: {name: string}) => ({...schema, name: 'test:renamed'}),
  } as unknown as Tx
  const fill = (properties: Record<string, unknown>) =>
    withAbsentPropertyValues(renamingTx, BLOCK, properties, [propertyValue(stageProp, 'draft')])

  it('writes under the canonical name when neither name is held', async () => {
    expect(await fill({})).toEqual({'test:renamed': 'draft'})
  })

  it('treats a value under either the handle\'s name or the canonical name as held', async () => {
    expect(await fill({[stageProp.name]: 'final'})).toBeNull()
    expect(await fill({'test:renamed': null})).toBeNull()
  })
})
