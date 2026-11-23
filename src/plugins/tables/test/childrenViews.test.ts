/** A table host's drawn members, as the outline's walks read them: its
 *  query's field rows, its grid, then under a query its children the query
 *  does not select, drawn below the grid in the host's own scope. */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { ChangeScope } from '@/data/api'
import { propertyDefinitionBlockId, materializePropertySeeds } from '@/data/definitionSeeds'
import { outlineSurfaceOf } from '@/data/outlineSurface'
import type { Repo } from '@/data/repo'
import { createTestDb, resetTestDb, type TestDb } from '@/data/test/createTestDb'
import { createTestRepo } from '@/data/test/createTestRepo'
import { drawnChildrenOf } from '@/data/visibleChildren'
import { nextDrawnStep, previousDrawnStep } from '@/utils/selection'
import { tableChildrenViews } from '../childrenViews'
import { GridController } from '../controller'
import { turnIntoTable } from '../convert'
import { tablesDataExtension } from '../dataExtension'
import { openQueryValue } from '../query/queryValue'
import { registerGrid, tableRenderScopeId } from '../registry'
import { queryProp } from '../schema'

const workspaceId = 'ws-table-children-views'
const options = {scope: ChangeScope.BlockDefault}
const PAGE = 'panel:page'
const TABLE = tableRenderScopeId(PAGE, 'host')
const ROWS = ['row-0', 'row-1']
const GRID = {kind: 'nested-surface', renderScopeId: TABLE}

let db: TestDb
let repo: Repo
let controller: GridController
let releaseGrid: () => void
beforeAll(async () => { db = await createTestDb() })
afterAll(async () => { await db.cleanup() })
afterEach(() => releaseGrid())
beforeEach(async () => {
  await resetTestDb(db.db)
  await db.db.execute(
    `INSERT INTO workspaces (id, name, owner_user_id, create_time, update_time, encryption_mode, properties_migration)
      VALUES (?, 'test', 'test-user', 1, 1, 'none', 'children')`, [workspaceId])
  ;({repo} = createTestRepo({db: db.db, user: {id: 'user-1'}, extensions: [tablesDataExtension, tableChildrenViews]}))
  repo.setActiveWorkspaceId(workspaceId)
  await repo.tx(async tx => {
    await tx.create({id: 'ui', workspaceId, parentId: null, orderKey: 'a0'})
    await tx.create({id: 'page', workspaceId, parentId: null, orderKey: 'b0', content: 'Page'})
    await tx.create({id: 'host', workspaceId, parentId: 'page', orderKey: 'a0', content: 'Table'})
    await tx.create({id: 'after', workspaceId, parentId: 'page', orderKey: 'a1', content: 'After'})
    for (const [index, id] of ROWS.entries()) {
      await tx.create({id, workspaceId, parentId: 'host', orderKey: `a${index}`, content: `Row ${index}`})
    }
  }, options)
  await turnIntoTable(repo, 'host')
  controller = new GridController(repo.block('host'), repo.block('ui'), TABLE, PAGE)
  controller.setRows(ROWS, ROWS.length)
  releaseGrid = registerGrid(TABLE, controller)
})

const surface = () => outlineSurfaceOf({scopeRootId: 'page', propertyDisplay: {childBacked: true, workspace: 'none', panel: 'inherit'}, renderScopeId: PAGE})!

/** A query on the host, and two of its children the query does not select. */
const withQuery = async () => {
  await materializePropertySeeds(repo, workspaceId, [queryProp])
  const valueId = await openQueryValue(repo, 'host', propertyDefinitionBlockId(workspaceId, queryProp.seedKey))
  const fieldRowId = (await repo.load(valueId))!.parentId!
  await repo.tx(async tx => {
    await tx.create({id: 'outside-0', workspaceId, parentId: 'host', orderKey: 'a0x', content: 'outside 0'})
    await tx.create({id: 'outside-1', workspaceId, parentId: 'host', orderKey: 'a3', content: 'outside 1'})
  }, options)
  controller.setQuery([])
  return {fieldRowId, valueId}
}

describe('a table host’s drawn members', () => {
  it('without a query: the grid alone, its rows and configuration never walked', async () => {
    expect(await drawnChildrenOf(repo.block('host'), surface())).toEqual([GRID])
    expect(await previousDrawnStep(repo.block('after'), surface())).toMatchObject({block: {id: 'host'}, crossed: true})
  })

  it('under a query: its field row, the grid, then its children outside the query', async () => {
    const {fieldRowId, valueId} = await withQuery()
    expect(await drawnChildrenOf(repo.block('host'), surface())).toEqual([fieldRowId, GRID, 'outside-0', 'outside-1'])
    expect(await nextDrawnStep(repo.block('outside-0'), surface())).toMatchObject({block: {id: 'outside-1'}, crossed: false})
    expect(await previousDrawnStep(repo.block('after'), surface())).toMatchObject({block: {id: 'outside-1'}, crossed: false})
    expect(await previousDrawnStep(repo.block('outside-0'), surface())).toMatchObject({block: {id: valueId}, crossed: true})
  })
})
