// @vitest-environment happy-dom
/** Up and Down in normal mode around a table, through the real dispatch path:
 *  vim's outline verb, spatial navigation's wrap, and the table's wraps, over
 *  a panel drawn the way `TableHostLayout` draws it. */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { ChangeScope } from '@/data/api'
import type { Block } from '@/data/block'
import { materializePropertySeeds, propertyDefinitionBlockId } from '@/data/definitionSeeds'
import { focusBlock, focusedBlockLocationProp, topLevelBlockIdProp } from '@/data/properties'
import type { Repo } from '@/data/repo'
import { createTestDb, resetTestDb, type TestDb } from '@/data/test/createTestDb'
import { createTestRepo } from '@/data/test/createTestRepo'
import { resolveFacetRuntimeSync, type FacetRuntime } from '@/facets/facet'
import { spatialNavigationActionDecoratorsExtension } from '@/plugins/spatial-navigation/actions'
import { getVimNormalModeActions } from '@/plugins/vim-normal-mode/actions'
import { invokeAction } from '@/shortcuts/actionDispatch'
import type { ActionTrigger, BlockShortcutDependencies } from '@/shortcuts/types'
import { waitFor } from '@/test/waitFor'
import { GridController } from '../controller'
import { turnIntoTable } from '../convert'
import { tablesDataExtension } from '../dataExtension'
import { tableOutlineVerbRedirects } from '../keys'
import { TABLE_CHILDREN_ATTRIBUTE, TABLE_HOST_ATTRIBUTE } from '../navigation'
import { openQueryValue } from '../query/queryValue'
import { registerGrid, tableRenderScopeId } from '../registry'
import { queryProp } from '../schema'

const workspaceId = 'ws-table-navigation'
const options = {scope: ChangeScope.BlockDefault}
const PAGE = 'panel:page'
const TABLE = tableRenderScopeId(PAGE, 'host')
const ROWS = ['row-0', 'row-1', 'row-2']

let db: TestDb
let repo: Repo
let panel: Block
let runtime: FacetRuntime
let releaseGrid: () => void
let controller: GridController

beforeAll(async () => { db = await createTestDb() })
afterAll(async () => { await db.cleanup() })
afterEach(async () => {
  releaseGrid()
  document.body.innerHTML = ''
  await repo.awaitProcessors()
})
beforeEach(async () => {
  await resetTestDb(db.db)
  await db.db.execute(
    `INSERT INTO workspaces (id, name, owner_user_id, create_time, update_time, encryption_mode, properties_migration)
      VALUES (?, 'test', 'test-user', 1, 1, 'none', 'children')`, [workspaceId])
  ;({repo} = createTestRepo({db: db.db, user: {id: 'user-1'}, extensions: [tablesDataExtension]}))
  repo.setActiveWorkspaceId(workspaceId)
  await repo.tx(async tx => {
    await tx.create({id: 'panel', workspaceId, parentId: null, orderKey: 'a0',
      properties: {[topLevelBlockIdProp.name]: topLevelBlockIdProp.codec.encode('page')}})
    await tx.create({id: 'page', workspaceId, parentId: null, orderKey: 'b0', content: 'Page'})
    await tx.create({id: 'before', workspaceId, parentId: 'page', orderKey: 'a0', content: 'Before'})
    await tx.create({id: 'host', workspaceId, parentId: 'page', orderKey: 'a1', content: 'Table'})
    await tx.create({id: 'after', workspaceId, parentId: 'page', orderKey: 'a2', content: 'After'})
    for (const [index, id] of ROWS.entries()) {
      await tx.create({id, workspaceId, parentId: 'host', orderKey: `a${index}`, content: `Row ${index}`})
    }
  }, options)
  await turnIntoTable(repo, 'host')
  panel = repo.block('panel')
  runtime = resolveFacetRuntimeSync([tableOutlineVerbRedirects, spatialNavigationActionDecoratorsExtension])
  controller = new GridController(repo.block('host'), panel, TABLE, PAGE)
  controller.setRows(ROWS, ROWS.length)
  releaseGrid = registerGrid(TABLE, controller)
})

/** The query's field row and its value, as `QueryFields` draws them. */
const addQuery = async () => {
  await materializePropertySeeds(repo, workspaceId, [queryProp])
  const valueId = await openQueryValue(repo, 'host', propertyDefinitionBlockId(workspaceId, queryProp.seedKey))
  const value = await repo.block(valueId).load()
  return {fieldRowId: value!.parentId!, valueId}
}

const navItem = (blockId: string, renderScopeId: string, children: HTMLElement[] = []) => {
  const element = document.createElement('div')
  element.dataset.blockNavItem = 'true'
  element.dataset.blockId = blockId
  element.dataset.renderScopeId = renderScopeId
  element.append(...children)
  return element
}

/** The panel as drawn: the host's shell holds what it draws above its table in
 *  its own scope (`aboveTable`), then the table's region: the query's field
 *  rows, then the rows in the table's scope. */
const drawPanel = ({query, rows = ROWS, aboveTable = [], below = false}: {
  query?: {fieldRowId: string; valueId: string}; rows?: readonly string[]; aboveTable?: HTMLElement[]; below?: boolean
} = {}) => {
  const region = document.createElement('div')
  region.setAttribute(TABLE_CHILDREN_ATTRIBUTE, 'true')
  if (query) region.append(navItem(query.fieldRowId, PAGE, [navItem(query.valueId, PAGE)]))
  region.append(...rows.map(id => navItem(id, TABLE)))
  const host = navItem('host', PAGE, [...aboveTable, region])
  host.setAttribute(TABLE_HOST_ATTRIBUTE, 'true')
  const root = document.createElement('div')
  root.dataset.panelId = 'panel'
  root.append(navItem('before', PAGE), host, ...(below ? [] : [navItem('after', PAGE)]))
  if (!below) {
    document.body.append(root)
    return
  }
  // The table ends its panel, and another panel is stacked below it.
  const column = document.createElement('div')
  column.dataset.layoutColumnId = 'column'
  const lower = document.createElement('div')
  lower.dataset.panelId = 'panel-below'
  lower.append(navItem('after', 'panel:below'))
  column.append(root, lower)
  document.body.append(column)
}

const press = async (direction: 'up' | 'down', blockId: string, renderScopeId: string) => {
  await focusBlock(panel, blockId, {renderScopeId})
  const action = getVimNormalModeActions({repo}).find(candidate => candidate.id === (direction === 'down' ? 'move_down' : 'move_up'))!
  // A row is the root of its own scope (`TableRow`); everything else is the page's.
  const deps: BlockShortcutDependencies = {
    block: repo.block(blockId), uiStateBlock: panel, renderScopeId,
    scopeRootId: renderScopeId === TABLE ? blockId : 'page',
  }
  await invokeAction(runtime, {action, deps, trigger: {} as ActionTrigger})
}

const expectFocus = (blockId: string, renderScopeId: string) => waitFor(() => {
  expect(panel.peekProperty(focusedBlockLocationProp)).toEqual({blockId, renderScopeId})
})

describe('Up and Down around a table', () => {
  it('Down from the host lands on the first row, where the grid draws it', async () => {
    drawPanel()
    await press('down', 'host', PAGE)
    await expectFocus('row-0', TABLE)
  })

  it('Down from a host with a query lands on the query’s field row', async () => {
    const query = await addQuery()
    drawPanel({query})
    await press('down', 'host', PAGE)
    await expectFocus(query.fieldRowId, PAGE)
  })

  it('Down from the query’s value lands on the first row', async () => {
    const query = await addQuery()
    drawPanel({query})
    await press('down', query.valueId, PAGE)
    await expectFocus('row-0', TABLE)
  })

  it('Up from the query’s field row lands on the host', async () => {
    const query = await addQuery()
    drawPanel({query})
    await press('up', query.fieldRowId, PAGE)
    await expectFocus('host', PAGE)
  })

  it('Down from the last row leaves the table for the next block', async () => {
    drawPanel()
    await press('down', 'row-2', TABLE)
    await expectFocus('after', PAGE)
  })

  it('Up from the first row lands on the query’s value, not the host', async () => {
    const query = await addQuery()
    drawPanel({query})
    await press('up', 'row-0', TABLE)
    await expectFocus(query.valueId, PAGE)
  })

  it('Up from the first row of a table without a query lands on the host', async () => {
    drawPanel()
    await press('up', 'row-0', TABLE)
    await expectFocus('host', PAGE)
  })

  it('Up from the block after the table lands on the last row, where the grid draws it', async () => {
    drawPanel()
    await press('up', 'after', PAGE)
    await expectFocus('row-2', TABLE)
  })

  it('steps over a table that draws no rows', async () => {
    drawPanel({rows: []})
    controller.setRows([], 0)
    await press('down', 'host', PAGE)
    await expectFocus('after', PAGE)
    await press('up', 'after', PAGE)
    await expectFocus('host', PAGE)
  })

  it('Down from what the host draws above its table lands on the first row', async () => {
    // A property the host shows in its own scope, above the table.
    const query = await addQuery()
    drawPanel({aboveTable: [navItem(query.fieldRowId, PAGE)]})
    await press('down', query.fieldRowId, PAGE)
    await expectFocus('row-0', TABLE)
  })

  it('Down from the last row of a table that ends its panel moves to the panel below', async () => {
    await repo.tx(tx => tx.create({id: 'panel-below', workspaceId, parentId: null, orderKey: 'a1',
      properties: {[topLevelBlockIdProp.name]: topLevelBlockIdProp.codec.encode('after')}}), {scope: ChangeScope.UiState})
    drawPanel({below: true})
    await press('down', 'row-2', TABLE)
    await waitFor(() => {
      expect(repo.block('panel-below').peekProperty(focusedBlockLocationProp)).toEqual({blockId: 'after', renderScopeId: 'panel:below'})
    })
  })

  it('a row lands on a row not mounted yet where its slot holds its place', async () => {
    drawPanel({rows: ['row-0', 'row-1']})
    const slot = document.createElement('div')
    slot.dataset.lazyBlockId = 'row-2'
    slot.dataset.lazyRenderScopeId = TABLE
    document.querySelector(`[${TABLE_CHILDREN_ATTRIBUTE}]`)!.append(slot)
    await press('up', 'after', PAGE)
    await expectFocus('row-2', TABLE)
  })

  it('the grid declines Down from the last row, but absorbs it while the move there is still committing', async () => {
    await focusBlock(panel, 'row-1', {renderScopeId: TABLE})
    expect(controller.command('down')).toBe(true)
    // The write to the last row has not committed: the outline would step from the row before it.
    expect(controller.command('down')).toBe(true)
    await waitFor(() => expect(controller.getPendingRow()).toBeNull())
    expect(panel.peekProperty(focusedBlockLocationProp)).toEqual({blockId: 'row-2', renderScopeId: TABLE})
    expect(controller.command('down')).toBe(false)
  })
})
