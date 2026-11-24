// @vitest-environment happy-dom
/** The grid's step out at its edges while a move is still committing. */
import { afterAll, beforeAll, beforeEach, expect, it, vi } from 'vitest'
import { ChangeScope } from '@/data/api'
import { focusBlock, topLevelBlockIdProp } from '@/data/properties'
import { createTestDb, resetTestDb, type TestDb } from '@/data/test/createTestDb'
import { createTestRepo } from '@/data/test/createTestRepo'
import { waitFor } from '@/test/waitFor'
import { GridController } from '../controller'
import { moveVertical } from '@/plugins/spatial-navigation/actions'

vi.mock('@/plugins/spatial-navigation/actions', () => ({moveVertical: vi.fn(async () => true)}))

const workspaceId = 'ws-grid-edges'
const SCOPE = 'tables:panel:host'
const ROWS = ['row-0', 'row-1', 'row-2']

let db: TestDb
beforeAll(async () => { db = await createTestDb() })
afterAll(async () => { await db.cleanup() })
beforeEach(async () => {
  await resetTestDb(db.db)
  vi.mocked(moveVertical).mockClear()
})

it('absorbs a key at the last row while the move there is still committing: a step written then would be overwritten', async () => {
  const {repo} = createTestRepo({db: db.db, user: {id: 'user-1'}})
  repo.setActiveWorkspaceId(workspaceId)
  await repo.tx(async tx => {
    await tx.create({id: 'panel', workspaceId, parentId: null, orderKey: 'a0',
      properties: {[topLevelBlockIdProp.name]: topLevelBlockIdProp.codec.encode('host')}})
    await tx.create({id: 'host', workspaceId, parentId: null, orderKey: 'b0', content: 'Table'})
    for (const [index, id] of ROWS.entries()) {
      await tx.create({id, workspaceId, parentId: 'host', orderKey: `a${index}`, content: `Row ${index}`})
    }
  }, {scope: ChangeScope.BlockDefault})
  const panel = repo.block('panel')
  const controller = new GridController(repo.block('host'), panel, SCOPE, 'panel:host')
  controller.setRows(ROWS, ROWS.length)
  await focusBlock(panel, 'row-1', {renderScopeId: SCOPE})

  expect(controller.command('down')).toBe(true)
  expect(controller.getPendingRow()).toBe('row-2')
  expect(controller.command('down')).toBe(true)
  expect(moveVertical).not.toHaveBeenCalled()

  await waitFor(() => expect(controller.getPendingRow()).toBeNull())
  expect(controller.command('down')).toBe(true)
  expect(moveVertical).toHaveBeenCalledOnce()
})
