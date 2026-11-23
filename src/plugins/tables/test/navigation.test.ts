// @vitest-environment happy-dom
/** Up and Down in normal mode around a table, through the real dispatch path:
 *  vim's outline verb, spatial navigation's wrap, and the table's wraps, over
 *  a panel drawn the way `TableHostLayout` draws it. */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { ChangeScope } from '@/data/api'
import type { Block } from '@/data/block'
import { materializePropertySeeds, propertyDefinitionBlockId } from '@/data/definitionSeeds'
import { outlineSurfaceOf } from '@/data/outlineSurface'
import { focusBlock, focusedBlockLocationProp, isCollapsedProp, topLevelBlockIdProp } from '@/data/properties'
import type { Repo } from '@/data/repo'
import { createTestDb, resetTestDb, type TestDb } from '@/data/test/createTestDb'
import { createTestRepo } from '@/data/test/createTestRepo'
import { resolveFacetRuntimeSync, type FacetRuntime } from '@/facets/facet'
import { spatialNavigationActionDecoratorsExtension } from '@/plugins/spatial-navigation/actions'
import { spatialNavExclusionsFacet } from '@/plugins/spatial-navigation/exclusionsFacet'
import { getVimNormalModeActions } from '@/plugins/vim-normal-mode/actions'
import { invokeAction } from '@/shortcuts/actionDispatch'
import type { ActionTrigger, BlockShortcutDependencies } from '@/shortcuts/types'
import { waitFor } from '@/test/waitFor'
import { GridController } from '../controller'
import { turnIntoTable } from '../convert'
import { tablesDataExtension } from '../dataExtension'
import { tableOutlineVerbRedirects } from '../keys'
import { CELL_SURFACE } from '../TableLayout'
import { tableChildrenViews } from '../childrenViews'
import { openQueryValue } from '../query/queryValue'
import { registerGrid, tableRenderScopeId } from '../registry'
import { queryProp } from '../schema'

const workspaceId = 'ws-table-navigation'
const options = {scope: ChangeScope.BlockDefault}
const PAGE = 'panel:page'
const TABLE = tableRenderScopeId(PAGE, 'host')
const ROWS = ['row-0', 'row-1', 'row-2']
const DISPLAY = {childBacked: true, workspace: 'none', panel: 'inherit'} as const
const OUTLINE = outlineSurfaceOf({scopeRootId: 'page', renderScopeId: PAGE, propertyDisplay: DISPLAY})!

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
  ;({repo} = createTestRepo({db: db.db, user: {id: 'user-1'}, extensions: [tablesDataExtension, tableChildrenViews, spatialNavExclusionsFacet.of(CELL_SURFACE, {source: 'tables'})]}))
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
  controller.setSurfaces({...DISPLAY, panel: 'none'}, OUTLINE)
  releaseGrid = registerGrid(TABLE, controller)
})

/** The query's field row and its value, as `QueryFields` draws them. */
const addQuery = async () => {
  await materializePropertySeeds(repo, workspaceId, [queryProp])
  const valueId = await openQueryValue(repo, 'host', propertyDefinitionBlockId(workspaceId, queryProp.seedKey))
  const value = await repo.block(valueId).load()
  controller.setQuery([])
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
 *  rows, the grid's rows in the table's scope (each with a cell, which spatial
 *  navigation skips), and the children outside the query (`outside`), in the
 *  host's scope. A collapsed host draws no region. */
const drawPanel = ({query, rows = ROWS, aboveTable = [], outside = [], below = false, collapsed = false, after = [navItem('after', PAGE)]}: {
  query?: {fieldRowId: string; valueId: string}; rows?: readonly string[]; aboveTable?: HTMLElement[]
  outside?: HTMLElement[]; below?: boolean; collapsed?: boolean; after?: HTMLElement[]
} = {}) => {
  const cell = (rowId: string) => {
    const element = navItem(`${rowId}-value`, TABLE)
    element.dataset.blockSurface = CELL_SURFACE
    return element
  }
  const grid = document.createElement('div')
  grid.dataset.testGrid = 'true'
  grid.append(...rows.map(id => navItem(id, TABLE, [cell(id)])))
  const tableRegion = document.createElement('div')
  if (query) tableRegion.append(navItem(query.fieldRowId, PAGE, [navItem(query.valueId, PAGE)]))
  tableRegion.append(grid, ...outside)
  const region = collapsed ? [] : [tableRegion]
  const host = navItem('host', PAGE, [...aboveTable, ...region])
  const root = document.createElement('div')
  root.dataset.panelId = 'panel'
  root.append(navItem('before', PAGE), host, ...(below ? [] : after))
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
    scopeRootForcesOpen: renderScopeId !== TABLE,
    propertyDisplay: renderScopeId === TABLE ? controller.rowsDisplayScope : DISPLAY,
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
    await repo.block(query.fieldRowId).set(isCollapsedProp, true)
    drawPanel({aboveTable: [navItem(query.fieldRowId, PAGE)]})
    await press('down', query.fieldRowId, PAGE)
    await expectFocus('row-0', TABLE)
  })

  it('Down from the last row of a table that ends its panel moves to the panel below', async () => {
    await repo.tx(tx => tx.create({id: 'panel-below', workspaceId, parentId: null, orderKey: 'a1',
      properties: {[topLevelBlockIdProp.name]: topLevelBlockIdProp.codec.encode('after')}}), {scope: ChangeScope.UiState})
    // The grid draws the row's note, but row mode skips the subtree on exit.
    await repo.tx(tx => tx.create({id: 'row-2-child', workspaceId, parentId: 'row-2', orderKey: 'a0', content: 'child'}), options)
    await repo.tx(tx => tx.move('after', {parentId: null, orderKey: 'c0'}), options)
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
    document.querySelector('[data-test-grid]')!.append(slot)
    await press('up', 'after', PAGE)
    await expectFocus('row-2', TABLE)
  })

  it('the grid leaves at its first and last row without vim', async () => {
    const query = await addQuery()
    drawPanel({query})
    await focusBlock(panel, 'row-2', {renderScopeId: TABLE})
    expect(controller.command('down')).toBe(true)
    await expectFocus('after', PAGE)
    await focusBlock(panel, 'row-0', {renderScopeId: TABLE})
    expect(controller.command('up')).toBe(true)
    await expectFocus(query.valueId, PAGE)
  })

  describe('children outside the query', () => {
    // Interleaved with the rows the query selects, as the outline model orders them.
    const addOutside = async () => {
      await repo.tx(async tx => {
        await tx.create({id: 'outside-0', workspaceId, parentId: 'host', orderKey: 'a0x', content: 'outside 0'})
        await tx.create({id: 'outside-1', workspaceId, parentId: 'host', orderKey: 'a3', content: 'outside 1'})
      }, options)
      controller.setQuery([])
    }

    it('steps between them as drawn, not into the rows the model puts between them', async () => {
      await addOutside()
      drawPanel({outside: [navItem('outside-0', PAGE), navItem('outside-1', PAGE)]})
      await press('down', 'outside-0', PAGE)
      await expectFocus('outside-1', PAGE)
      await press('up', 'outside-0', PAGE)
      await expectFocus('row-2', TABLE)
      await press('down', 'row-2', TABLE)
      await expectFocus('outside-0', PAGE)
    })

    it('lands on one not mounted yet, where its slot holds its place', async () => {
      await addOutside()
      const slot = document.createElement('div')
      slot.dataset.lazyBlockId = 'outside-1'
      slot.dataset.lazyRenderScopeId = PAGE
      drawPanel({outside: [navItem('outside-0', PAGE), slot]})
      await press('down', 'outside-0', PAGE)
      await expectFocus('outside-1', PAGE)
    })
  })

  it('Down from a collapsed host lands on the next block not mounted yet', async () => {
    await repo.tx(tx => tx.create({id: 'after-2', workspaceId, parentId: 'page', orderKey: 'a3', content: 'After 2'}), options)
    const slot = document.createElement('div')
    slot.dataset.lazyBlockId = 'after'
    slot.dataset.lazyRenderScopeId = PAGE
    await repo.block('host').set(isCollapsedProp, true)
    drawPanel({collapsed: true, after: [slot, navItem('after-2', PAGE)]})
    await press('down', 'host', PAGE)
    await expectFocus('after', PAGE)
  })

  it('with no drawn step to take (spatial navigation off), the grid’s Up at its first row still reaches the host', async () => {
    await repo.tx(tx => tx.move('after', {parentId: null, orderKey: 'c0'}), options)
    await focusBlock(panel, 'row-0', {renderScopeId: TABLE})
    expect(controller.command('up')).toBe(true)
    await expectFocus('host', PAGE)
    await focusBlock(panel, 'row-2', {renderScopeId: TABLE})
    expect(controller.command('down')).toBe(true)
    await expectFocus('row-2', TABLE)
  })
})
