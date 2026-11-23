// @vitest-environment happy-dom
/** A table host's drawn members, as the outline's walks read them: its
 *  query's field rows, its grid, then under a query its children the query
 *  does not select, drawn below the grid in the host's own scope. */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { ChangeScope } from '@/data/api'
import { propertyDefinitionBlockId, materializePropertySeeds } from '@/data/definitionSeeds'
import { outlineSurfaceOf } from '@/data/outlineSurface'
import { focusBlock, peekFocusedBlockLocation } from '@/data/properties'
import { disarmCut, getArmedCut } from '@/paste/armedCut'
import { getDefaultActions } from '@/shortcuts/defaultShortcuts'
import { ActionContextTypes, type ActionTrigger } from '@/shortcuts/types'
import type { Repo } from '@/data/repo'
import { createTestDb, resetTestDb, type TestDb } from '@/data/test/createTestDb'
import { createTestRepo } from '@/data/test/createTestRepo'
import { drawnChildrenOf } from '@/data/visibleChildren'
import { getBlocksInRange, locationAfterSubtreeRemoval, nextDrawnStep, previousDrawnStep } from '@/utils/selection'
import { tableChildrenViews } from '../childrenViews'
import { GridController } from '../controller'
import { turnIntoTable } from '../convert'
import { tablesDataExtension } from '../dataExtension'
import { openQueryValue } from '../query/queryValue'
import { registerGrid, tableNotesScopeId, tableRenderScopeId } from '../registry'
import { queryProp } from '../schema'

const workspaceId = 'ws-table-children-views'
const options = {scope: ChangeScope.BlockDefault}
const PAGE = 'panel:page'
const TABLE = tableRenderScopeId(PAGE, 'host')
const ROWS = ['row-0', 'row-1']
const grid = (members: readonly string[]) => ({
  kind: 'nested-surface', renderScopeId: TABLE, members, isolateSelection: true, propertyDisplay: controller.rowsDisplayScope,
})

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
  controller.parentSurface = surface()
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
  it('without a query: walks the grid’s rows in their own scope and skips its configuration', async () => {
    expect(await drawnChildrenOf(repo.block('host'), surface())).toEqual([grid(ROWS)])
    expect(await previousDrawnStep(repo.block('after'), surface())).toMatchObject({block: {id: 'row-1'}, surface: {renderScopeId: TABLE}, crossed: true})
  })

  it('without a query, a child the grid does not draw (past its cap) is no child outside a query', async () => {
    controller.setRows(['row-0'], ROWS.length)
    expect(await drawnChildrenOf(repo.block('host'), surface())).toEqual([grid(['row-0'])])
  })

  it.each([
    {name: 'plain', rows: ROWS, sorted: false},
    {name: 'sorted', rows: [...ROWS].reverse(), sorted: true},
  ])('stops an outline selection at the $name grid', async ({rows, sorted}) => {
    controller.setSorted(sorted)
    controller.setRows(rows, rows.length)
    expect(await getBlocksInRange('host', rows[0]!, surface(), repo, TABLE)).toEqual([])
    expect(await getBlocksInRange('host', 'after', surface(), repo, PAGE)).toEqual([])
  })

  it('under a query: its field row, the grid, then its children outside the query', async () => {
    const {fieldRowId} = await withQuery()
    expect(await drawnChildrenOf(repo.block('host'), surface())).toEqual([fieldRowId, grid(ROWS), 'outside-0', 'outside-1'])
    expect(await nextDrawnStep(repo.block('outside-0'), surface())).toMatchObject({block: {id: 'outside-1'}, crossed: false})
    expect(await previousDrawnStep(repo.block('after'), surface())).toMatchObject({block: {id: 'outside-1'}, crossed: false})
    expect(await previousDrawnStep(repo.block('outside-0'), surface())).toMatchObject({block: {id: 'row-1'}, surface: {renderScopeId: TABLE}, crossed: true})
  })
})

it('walks from an unmounted query note through its declared row owner', async () => {
  await withQuery()
  await repo.tx(tx => tx.create({id: 'note', workspaceId, parentId: 'row-0', orderKey: 'a0', content: 'A note'}), options)
  const notesScope = tableNotesScopeId(TABLE, 'row-0')
  const notes = {...controller.rowSurface('row-0'), renderScopeId: notesScope}
  expect(await previousDrawnStep(repo.block('note'), notes))
    .toMatchObject({block: {id: 'row-0'}, surface: {renderScopeId: TABLE}, crossed: true})
  expect(await nextDrawnStep(repo.block('note'), notes))
    .toMatchObject({block: {id: 'row-1'}, surface: {renderScopeId: TABLE}, crossed: true})
})

const withProjectedDescendant = async () => {
  await withQuery()
  await repo.mutate.move({id: 'row-0', parentId: 'outside-1', position: {kind: 'last'}})
  await repo.mutate.move({id: 'outside-0', parentId: 'outside-1', position: {kind: 'last'}})
  controller.setRows(['row-1', 'row-0'], 2)
  const uiStateBlock = repo.block('ui')
  const block = repo.block('outside-1')
  await focusBlock(uiStateBlock, block.id, {renderScopeId: PAGE})
  expect(await previousDrawnStep(block, surface())).toMatchObject({block: {id: 'row-0'}, surface: {renderScopeId: TABLE}})
  return {block, uiStateBlock}
}

it('Delete focuses a surviving grid result when the last outside child contains the last result', async () => {
  const {block, uiStateBlock} = await withProjectedDescendant()
  const action = getDefaultActions({repo}).find(action => action.id === 'delete_block' && action.context === ActionContextTypes.NORMAL_MODE)!
  await action.handler({block, uiStateBlock, ...surface()}, {preventDefault: vi.fn()} as unknown as ActionTrigger)
  expect(await repo.load('outside-1')).toBeNull()
  expect(await repo.load('row-0')).toBeNull()
  expect(await repo.load('row-1')).toBeDefined()
  await vi.waitFor(() => expect(peekFocusedBlockLocation(uiStateBlock)).toEqual({blockId: 'row-1', renderScopeId: TABLE}))
})

it('Cut keeps focus out of the armed subtree when it projects a grid result', async () => {
  const {block, uiStateBlock} = await withProjectedDescendant()
  vi.stubGlobal('ClipboardItem', class {})
  vi.stubGlobal('navigator', {clipboard: {write: vi.fn(async () => {})}})
  try {
    const action = getDefaultActions({repo}).find(action => action.id === 'cut_block' && action.context === ActionContextTypes.NORMAL_MODE)!
    await action.handler({block, uiStateBlock, ...surface()}, {preventDefault: vi.fn()} as unknown as ActionTrigger)
    expect(getArmedCut()).toBeDefined()
    await vi.waitFor(() => expect(peekFocusedBlockLocation(uiStateBlock)).toEqual({blockId: 'row-1', renderScopeId: TABLE}))
  } finally {
    disarmCut()
    vi.unstubAllGlobals()
  }
})

it('removal recovery skips projections of descendants of other selected roots', async () => {
  await withQuery()
  await repo.mutate.move({id: 'row-0', parentId: 'outside-0', position: {kind: 'last'}})
  controller.setRows(['row-1', 'row-0'], 2)
  const landing = await locationAfterSubtreeRemoval(repo.block('outside-1'), surface(), new Set(['outside-0']))
  expect(landing).toMatchObject({block: {id: 'row-1'}, surface: {renderScopeId: TABLE}})
})

it.each([['host', 'after'], ['page', null]] as const)('removal recovery leaves the grid when removing %s', async (removed, expected) => {
  await withQuery()
  const row = repo.block('row-0')
  await repo.mutate.move({id: 'row-1', parentId: 'ui', position: {kind: 'last'}})
  const landing = await locationAfterSubtreeRemoval(
    row, controller.rowSurface(row.id), new Set([removed]),
  )
  expect(landing?.block.id ?? null).toBe(expected)
  if (expected) expect(landing?.surface.renderScopeId).toBe(PAGE)
})
