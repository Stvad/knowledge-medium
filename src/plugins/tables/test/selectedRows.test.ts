// @vitest-environment happy-dom
import { afterAll, afterEach, beforeAll, beforeEach, expect, it, vi } from 'vitest'
import { ChangeScope } from '@/data/api'
import { outlineSurfaceOf } from '@/data/outlineSurface'
import { focusBlock, selectionStateProp } from '@/data/properties'
import type { Repo } from '@/data/repo'
import { createTestDb, resetTestDb, type TestDb } from '@/data/test/createTestDb'
import { createTestRepo } from '@/data/test/createTestRepo'
import { getVimNormalModeActions } from '@/plugins/vim-normal-mode/actions'
import { invokeAction } from '@/shortcuts/actionDispatch'
import { getDefaultActionGroups } from '@/shortcuts/defaultShortcuts'
import type { ActionTrigger } from '@/shortcuts/types'
import { GridController } from '../controller'
import { registerGrid, tableRenderScopeId } from '../registry'
import { tableOutlineVerbRedirects } from '../keys'
import { tableRowVerbs } from '../rowVerbs'

const PAGE_SCOPE = 'outline:page'
const GRID_SCOPE = tableRenderScopeId(PAGE_SCOPE, 'host')
const WORKSPACE = 'workspace'
const trigger = {preventDefault: vi.fn()} as unknown as ActionTrigger

let db: TestDb
let repo: Repo
let grid: GridController
let release: () => void

beforeAll(async () => { db = await createTestDb() })
afterAll(async () => { await db.cleanup() })
afterEach(() => release?.())

beforeEach(async () => {
  await resetTestDb(db.db)
  ;({repo} = createTestRepo({db: db.db, user: {id: 'user-1'}, extensions: [tableOutlineVerbRedirects, tableRowVerbs]}))
  repo.setActiveWorkspaceId(WORKSPACE)
  await repo.tx(async tx => {
    await tx.create({id: 'ui', workspaceId: WORKSPACE, parentId: null, orderKey: 'a0'})
    await tx.create({id: 'page', workspaceId: WORKSPACE, parentId: null, orderKey: 'a1'})
    await tx.create({id: 'host', workspaceId: WORKSPACE, parentId: 'page', orderKey: 'a0'})
    await tx.create({id: 'source', workspaceId: WORKSPACE, parentId: null, orderKey: 'a2'})
    await tx.create({id: 'sibling', workspaceId: WORKSPACE, parentId: 'source', orderKey: 'a0'})
    await tx.create({id: 'result', workspaceId: WORKSPACE, parentId: 'source', orderKey: 'a1'})
  }, {scope: ChangeScope.BlockDefault})
  grid = new GridController(repo.block('host'), repo.block('ui'), GRID_SCOPE, PAGE_SCOPE)
  grid.setQuery([])
  grid.setRows(['sibling', 'result'], 2)
  grid.parentSurface = outlineSurfaceOf({scopeRootId: 'page', renderScopeId: PAGE_SCOPE})!
  release = registerGrid(GRID_SCOPE, grid)
})

it('bulk indent on a selected query row refuses to reparent its source block', async () => {
  const {multiSelectModeActions} = getDefaultActionGroups({repo})
  const normalModeActions = getVimNormalModeActions({repo})
  const indent = normalModeActions.find(action => action.id === 'indent_block')!
  const select = normalModeActions.find(action => action.id === 'select_focused_block_and_start_selection')!
  const bulkIndent = multiSelectModeActions.find(action => action.id === 'multi_select.indent_block')!
  const block = repo.block('result')
  const uiStateBlock = repo.block('ui')
  const deps = {block, uiStateBlock, ...grid.rowSurface(block.id)}
  const runtime = repo.facetRuntime!

  await focusBlock(uiStateBlock, block.id, {renderScopeId: GRID_SCOPE})
  await invokeAction(runtime, {action: indent, deps, trigger})
  expect((await block.load())?.parentId).toBe('source')

  await invokeAction(runtime, {action: select, deps, trigger})
  expect(uiStateBlock.get(selectionStateProp)).toEqual({selectedBlockIds: ['result'], anchorBlockId: 'result'})
  const bulkDeps = {selectedBlocks: [block], anchorBlock: block, scopeRootId: 'page', uiStateBlock}
  await invokeAction(runtime, {action: bulkIndent, deps: bulkDeps, trigger})
  expect((await block.load())?.parentId).toBe('source')
})
