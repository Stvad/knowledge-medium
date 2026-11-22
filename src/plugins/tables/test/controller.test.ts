// @vitest-environment node

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { ChangeScope } from '@/data/api'
import { peekFocusedBlockLocation } from '@/data/properties'
import { getUIStateBlock } from '@/data/stateBlocks'
import { createTestDb, resetTestDb, type TestDb } from '@/data/test/createTestDb'
import { createTestRepo } from '@/data/test/createTestRepo'
import { peekValueOwner } from '../cellEdits'
import { GridController, type GridColumn } from '../controller'
import { turnIntoTable } from '../convert'
import { tablesDataExtension } from '../dataExtension'
import { ROW_CAP } from '../model'

const workspaceId = 'ws-table-controller'
const scope = 'tables:panel:host'
const options = {scope: ChangeScope.BlockDefault}

let db: TestDb
beforeAll(async () => { db = await createTestDb() })
afterAll(async () => { await db.cleanup() })
beforeEach(async () => { await resetTestDb(db.db) })

const children = (id: string) => db.db.getAll<{id: string; properties_json: string}>(
  'SELECT id, properties_json FROM blocks WHERE parent_id = ? AND deleted = 0 AND is_field_form IS NOT 1 ORDER BY order_key, id', [id],
)
const rowsOf = async (host: string) => (await children(host)).filter(child => !child.properties_json.includes('tables:view'))

/** A table over `rows` rows, and a grid controller for it that has not been told its rows yet. */
const setup = async (rows: number) => {
  await db.db.execute(
    `INSERT INTO workspaces (id, name, owner_user_id, create_time, update_time, encryption_mode, properties_migration)
      VALUES (?, 'test', 'test-user', 1, 1, 'none', 'children')`,
    [workspaceId],
  )
  const {repo} = createTestRepo({db: db.db, user: {id: 'user-1'}, extensions: [tablesDataExtension]})
  repo.setActiveWorkspaceId(workspaceId)
  await repo.tx(async tx => {
    await tx.create({id: 'host', workspaceId, parentId: null, orderKey: 'a0', content: 'Table'})
    for (let index = 0; index < rows; index++) {
      await tx.create({id: `row-${index}`, workspaceId, parentId: 'host', orderKey: `a${String(index).padStart(4, '0')}`, content: ''})
    }
  }, options)
  await turnIntoTable(repo, 'host')
  const uiStateBlock = await getUIStateBlock(repo, workspaceId, {id: 'user-1', name: 'Test'}, {})
  const controller = new GridController(repo.block('host'), uiStateBlock, scope, '')
  const rowIds = (await rowsOf('host')).map(row => row.id)
  return {repo, uiStateBlock, controller, rowIds}
}

const column = (id: string, fieldId: string | null = id): GridColumn => ({id, fieldId, editable: true, list: false})

describe('GridController', () => {
  it('keeps the cursor on its column when the columns are reordered or one is hidden', async () => {
    const {controller} = await setup(1)
    controller.setColumns([column('title', null), column('a'), column('b')])
    controller.setColumn(2)
    controller.setColumns([column('title', null), column('b'), column('a')])
    expect(controller.currentColumn).toBe(1)
    controller.setColumns([column('b'), column('a')])
    expect(controller.currentColumn).toBe(0)
  })

  it('inserts the first row above the first row, edited in the table’s scope', async () => {
    const {controller, uiStateBlock, rowIds} = await setup(2)
    controller.setColumns([column('title', null)])
    controller.setRows(rowIds, rowIds.length)
    await controller.insertFirstRow()
    const [created, ...rest] = await rowsOf('host')
    expect(rest.map(row => row.id)).toEqual(rowIds)
    expect(peekFocusedBlockLocation(uiStateBlock)).toMatchObject({blockId: created!.id, renderScopeId: scope})
    expect((await children('host'))[0]!.properties_json).toContain('tables:view')
  })

  it('appends after the view when there are no rows', async () => {
    const {controller} = await setup(0)
    controller.setColumns([column('title', null)])
    controller.setRows([], 0)
    await controller.insertFirstRow()
    const all = await children('host')
    expect(all).toHaveLength(2)
    expect(all[0]!.properties_json).toContain('tables:view')
  })

  it('inserts nothing before the rows have loaded', async () => {
    const {controller} = await setup(2)
    controller.setColumns([column('title', null)])
    await controller.insertFirstRow()
    expect(await rowsOf('host')).toHaveLength(2)
  })

  it('inserts nothing at the row cap', async () => {
    const {controller, rowIds} = await setup(2)
    controller.setColumns([column('title', null)])
    controller.setRows(rowIds, ROW_CAP)
    await controller.insertFirstRow()
    expect(await rowsOf('host')).toHaveLength(2)
  })

  // Defence in depth: a block under a member that is a reference is never
  // read as a value of a property named by that reference.
  it('reads a block nested under a reference member as no property value', async () => {
    const {repo} = await setup(1)
    await repo.tx(async tx => {
      await tx.create({id: 'target', workspaceId, parentId: null, orderKey: 'b0', content: 'Target'})
      await tx.create({id: 'ref-member', workspaceId, parentId: 'row-0', orderKey: 'a0', content: '((target))'})
      await tx.stampReferenceTarget('ref-member', 'target', false)
      await tx.create({id: 'nested', workspaceId, parentId: 'ref-member', orderKey: 'a0', content: 'note'})
    }, options)
    await Promise.all([repo.load('nested'), repo.load('ref-member')])
    expect(repo.block('ref-member').peek()?.referenceTargetId).toBe('target')
    expect(peekValueOwner(repo, 'nested')).toBeUndefined()
  })

  describe('row gestures a query or a sort decides', () => {
    const parentOf = async (id: string) => (await db.db.get<{parent_id: string}>('SELECT parent_id FROM blocks WHERE id = ?', [id])).parent_id

    it('nests and un-nests no rows under a query', async () => {
      const {repo, controller, rowIds} = await setup(2)
      controller.setRows(rowIds, rowIds.length)
      controller.setQuery([{kind: 'property', text: 'x'} as never])
      await controller.nestRow(rowIds[1]!)
      expect(await parentOf(rowIds[1]!)).toBe('host')
      const child = await repo.mutate.createChild({parentId: rowIds[0]!, content: 'child'})
      await controller.unnestChild(child!, rowIds[0]!)
      expect(await parentOf(child!)).toBe(rowIds[0])
    })

    it('nests a row under the row drawn above it, not the view', async () => {
      const {controller, rowIds} = await setup(2)
      controller.setRows(rowIds, rowIds.length)
      await controller.nestRow(rowIds[0]!)
      expect(await parentOf(rowIds[0]!)).toBe('host')
      await controller.nestRow(rowIds[1]!)
      expect(await parentOf(rowIds[1]!)).toBe(rowIds[0])
    })

    it('moves no rows when sorted or under a query', async () => {
      const {controller, rowIds} = await setup(2)
      controller.setRows(rowIds, rowIds.length)
      controller.setSorted(true)
      await controller.moveRow(rowIds[1]!, -1)
      expect((await rowsOf('host')).map(row => row.id)).toEqual(rowIds)
      controller.setSorted(false)
      controller.setQuery([{kind: 'property', text: 'x'} as never])
      await controller.moveRow(rowIds[1]!, -1)
      expect((await rowsOf('host')).map(row => row.id)).toEqual(rowIds)
    })
  })
})
