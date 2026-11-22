// @vitest-environment node

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { ChangeScope, seedType } from '@/data/api'
import { materializeTypeSeeds } from '@/data/definitionSeeds'
import { typeSeedsFacet } from '@/data/facets'
import { kernelValuePresetsExtension } from '@/components/propertyEditors/kernelValuePresets'
import { kernelPropertyUiExtension } from '@/components/propertyEditors/typesPropertyUi'
import { getOrCreatePropertiesPage } from '@/data/propertiesPage'
import { createTestDb, resetTestDb, type TestDb } from '@/data/test/createTestDb'
import { createTestRepo } from '@/data/test/createTestRepo'
import { createTypeBlock } from '@/data/typeExtraction'
import { getOrCreateTypesPage } from '@/data/typesPage'
import { addPropertyToType, typeTargetsFor } from '../columns'

const WS = 'ws-table-type-targets'
/** A code-owned type: its block mirrors the declaration and is not the user's to edit. */
const seeded = seedType({seedKey: 'system:tables-test/type/seeded', revision: 1, id: 'tables-test:seeded', label: 'Seeded'})

let db: TestDb
beforeAll(async () => { db = await createTestDb() })
afterAll(async () => { await db.cleanup() })
beforeEach(async () => { await resetTestDb(db.db) })

/** Two rows that both carry `book`; only the first carries `novel`. */
const setup = async () => {
  const {repo} = createTestRepo({db: db.db, user: {id: 'user-1'}, extensions: [
    kernelPropertyUiExtension, kernelValuePresetsExtension, typeSeedsFacet.of(seeded, {source: 'test'}),
  ]})
  repo.setActiveWorkspaceId(WS)
  await getOrCreatePropertiesPage(repo, WS)
  await getOrCreateTypesPage(repo, WS)
  const schema = await repo.userSchemas.addSchema({name: 'author', presetId: 'string'})
  const fieldId = repo.userSchemas.getSchemaBlockId(schema.name)!
  const book = await createTypeBlock(repo, {workspaceId: WS, label: 'book', propertySchemaIds: []})
  const novel = await createTypeBlock(repo, {workspaceId: WS, label: 'novel', propertySchemaIds: []})
  await materializeTypeSeeds(repo, WS, [seeded])
  const rows = ['dune', 'emma']
  await repo.tx(async tx => {
    for (const [index, id] of rows.entries()) {
      await tx.create({id, workspaceId: WS, parentId: null, orderKey: `r${index}`, content: id})
      await repo.addTypeInTx(tx, id, book)
      await repo.addTypeInTx(tx, id, seeded.id)
    }
    await repo.addTypeInTx(tx, 'dune', novel)
  }, {scope: ChangeScope.BlockDefault})
  return {repo, fieldId, book, rows}
}

describe('typeTargetsFor', () => {
  it('offers the user types every row carries', async () => {
    const {repo, fieldId, book, rows} = await setup()
    const targets = await typeTargetsFor(repo, WS, rows, fieldId)
    expect(targets.map(target => [target.typeId, target.label])).toEqual([[book, 'book']])
  })

  it('never offers a code-owned type, and adding to one writes nothing', async () => {
    const {repo, fieldId, rows} = await setup()
    const seededBlockId = repo.userTypes.getTypeBlockId(seeded.id)
    expect(seededBlockId).toBeDefined()
    expect((await typeTargetsFor(repo, WS, rows, fieldId)).map(target => target.typeId)).not.toContain(seeded.id)
    expect(await addPropertyToType(repo, seededBlockId!, fieldId)).toBe(false)
  })

  it('stops offering a type once it declares the property', async () => {
    const {repo, fieldId, book, rows} = await setup()
    expect(await addPropertyToType(repo, repo.userTypes.getTypeBlockId(book)!, fieldId)).toBe(true)
    expect(await typeTargetsFor(repo, WS, rows, fieldId)).toEqual([])
  })

  it('offers nothing for a table with no rows', async () => {
    const {repo, fieldId} = await setup()
    expect(await typeTargetsFor(repo, WS, [], fieldId)).toEqual([])
  })
})
