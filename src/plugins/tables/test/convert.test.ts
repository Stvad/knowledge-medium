// @vitest-environment node

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { ChangeScope, codecs, defineProperty } from '@/data/api'
import { projectedPropertyDefinitionsFacet } from '@/data/facets'
import { getBlockTypes, typesProp } from '@/data/properties'
import { createTestDb, resetTestDb, type TestDb } from '@/data/test/createTestDb'
import { createTestRepo } from '@/data/test/createTestRepo'
import { showTableAsOutline, turnIntoTable } from '../convert'
import { tablesDataExtension } from '../dataExtension'
import { rowQuery, viewQuery } from '../model'
import { COLUMN_TYPE, TABLE_TYPE, VIEW_TYPE, columnFieldProp } from '../schema'

const workspaceId = 'ws-tables'
const authorField = 'author-definition'
const author = defineProperty('test:author', {
  codec: codecs.string, defaultValue: '', changeScope: ChangeScope.BlockDefault,
})
const options = {scope: ChangeScope.BlockDefault}

let db: TestDb
beforeAll(async () => { db = await createTestDb() })
afterAll(async () => { await db.cleanup() })
beforeEach(async () => { await resetTestDb(db.db) })

const setup = async () => {
  await db.db.execute(
    `INSERT INTO workspaces (id, name, owner_user_id, create_time, update_time, encryption_mode, properties_migration)
      VALUES (?, 'test', 'test-user', 1, 1, 'none', 'children')`,
    [workspaceId],
  )
  const {repo} = createTestRepo({db: db.db, extensions: [tablesDataExtension]})
  repo.setActiveWorkspaceId(workspaceId)
  repo.setRuntimeContributions(projectedPropertyDefinitionsFacet, 'test-definition', [{
    metadata: {
      fieldId: authorField, workspaceId, createdAt: 1, name: author.name,
      changeScope: author.changeScope, hidden: false, origin: 'user',
    },
    schema: author,
  }], {workspaceId})
  await repo.tx(async tx => {
    await tx.create({id: authorField, workspaceId, parentId: null, orderKey: 'a0', content: 'author', properties: {types: ['property-schema']}})
    await tx.create({id: 'host', workspaceId, parentId: null, orderKey: 'a1', content: 'Reading list'})
    await tx.create({id: 'dune', workspaceId, parentId: 'host', orderKey: 'a0', content: 'Dune'})
    await tx.create({id: 'emma', workspaceId, parentId: 'host', orderKey: 'a1', content: 'Emma'})
    await tx.setProperty('emma', author, 'Austen')
    await tx.setProperty('dune', typesProp, ['page'])
  }, options)
  return repo
}

const childrenOf = (id: string) => db.db.getAll<{id: string; content: string; properties_json: string}>(
  'SELECT id, content, properties_json FROM blocks WHERE parent_id = ? AND deleted = 0 AND is_field_form IS NOT 1 ORDER BY order_key, id', [id],
)
const typesOf = (row: {properties_json: string}) => getBlockTypes({properties: JSON.parse(row.properties_json)})

describe('turnIntoTable', () => {
  it('adds one view whose columns are the rows’ text and the visible properties the rows carry', async () => {
    const repo = await setup()
    await turnIntoTable(repo, 'host')

    const [host] = await db.db.getAll<{properties_json: string}>('SELECT properties_json FROM blocks WHERE id = ?', ['host'])
    expect(typesOf(host!)).toContain(TABLE_TYPE)
    const [view, ...rows] = await childrenOf('host')
    expect(typesOf(view!)).toEqual([VIEW_TYPE])
    expect(rows.map(row => row.id)).toEqual(['dune', 'emma'])
    const columns = (await childrenOf(view!.id)).map(column => JSON.parse(column.properties_json) as Record<string, unknown>)
    expect(columns.map(column => getBlockTypes({properties: column}))).toEqual([[COLUMN_TYPE], [COLUMN_TYPE]])
    expect(columns.map(column => column[columnFieldProp.name] ?? null)).toEqual([null, authorField])
  })

  it('keeps an existing view rather than adding a second', async () => {
    const repo = await setup()
    await turnIntoTable(repo, 'host')
    await showTableAsOutline(repo, 'host')
    const [host] = await db.db.getAll<{properties_json: string}>('SELECT properties_json FROM blocks WHERE id = ?', ['host'])
    expect(typesOf(host!)).not.toContain(TABLE_TYPE)

    await turnIntoTable(repo, 'host')
    const views = (await childrenOf('host')).filter(child => typesOf(child).includes(VIEW_TYPE))
    expect(views).toHaveLength(1)
  })

  it('leaves the view and the host\u2019s own property rows out of the rows', async () => {
    const repo = await setup()
    await turnIntoTable(repo, 'host')
    await repo.tx(tx => tx.setProperty('host', author, 'Someone'), options)
    const viewIds = await repo.query.typedBlockIds(viewQuery('host', workspaceId)).load()
    expect(viewIds).toHaveLength(1)
    expect(await repo.query.typedBlockIds(rowQuery('host', workspaceId, null)).load()).toEqual(['dune', 'emma'])
  })

  it('refuses a property field row or value row, leaving the stored value alone', async () => {
    const repo = await setup()
    const [field] = await db.db.getAll<{id: string}>(
      'SELECT id FROM blocks WHERE parent_id = ? AND is_field_form = 1 AND reference_target_id = ?', ['emma', authorField])
    const [value] = await db.db.getAll<{id: string}>('SELECT id FROM blocks WHERE parent_id = ?', [field!.id])
    const before = await db.db.getAll('SELECT * FROM blocks ORDER BY id')
    await turnIntoTable(repo, field!.id)
    await turnIntoTable(repo, value!.id)
    expect(await db.db.getAll('SELECT * FROM blocks ORDER BY id')).toEqual(before)
  })
})
