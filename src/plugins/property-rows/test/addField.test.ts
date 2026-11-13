// @vitest-environment node
import {afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi} from 'vitest'
import {ChangeScope, seedProperty} from '@/data/api'
import {createTestDb, resetTestDb, type TestDb} from '@/data/test/createTestDb'
import {createTestRepo} from '@/data/test/createTestRepo'
import type {Repo} from '@/data/repo'
import {resolveFacetRuntimeSync} from '@/facets/facet'
import {invokeAction} from '@/shortcuts/actionDispatch'
import {__resetDialogsForTests, getDialogQueue} from '@/utils/dialogs'
import {beginInlineProperty} from '@/components/propertyPanel/inlinePropertyFlow'
import {showError} from '@/utils/toast'
import {addFieldAction, AddFieldDialog} from '../addField'
import {actionsFacet, appMountsFacet} from '@/extensions/core'
import {propertyRowsPlugin} from '../index'

vi.mock('@/components/propertyPanel/inlinePropertyFlow', () => ({beginInlineProperty: vi.fn()}))
vi.mock('@/utils/toast', () => ({showError: vi.fn()}))

const schema = seedProperty({seedKey: 'test/property/add-field', revision: 1, name: 'test:add-field', preset: 'string', changeScope: ChangeScope.BlockDefault})
let db: TestDb
let repo: Repo
beforeAll(async () => { db = await createTestDb() })
afterAll(async () => { await db.cleanup() })
beforeEach(async () => {
  vi.clearAllMocks()
  await resetTestDb(db.db)
  repo = createTestRepo({db: db.db}).repo
  repo.setActiveWorkspaceId('ws')
  await db.db.execute(`INSERT INTO workspaces
    (id, name, owner_user_id, create_time, update_time, encryption_mode, properties_migration)
    VALUES ('ws', 'Test', 'user', 1, 1, 'none', 'children')`)
  await repo.tx(async tx => {
    await tx.create({id: 'owner', workspaceId: 'ws', parentId: null, orderKey: 'a0', content: 'Owner'})
    await tx.create({id: 'ui', workspaceId: 'ws', parentId: null, orderKey: 'a1', content: ''})
  }, {scope: ChangeScope.BlockDefault})
})
afterEach(() => __resetDialogsForTests())

const dispatch = () => {
  const runtime = resolveFacetRuntimeSync(propertyRowsPlugin)
  const action = runtime.read(actionsFacet).find(item => item.id === addFieldAction.id)!
  expect(runtime.read(appMountsFacet).some(mount => mount.id === 'core.dialogs')).toBe(true)
  return invokeAction(runtime, {
    action,
    deps: {block: repo.block('owner'), uiStateBlock: repo.block('ui'), renderScopeId: 'scope'} as never,
    trigger: new CustomEvent('command'),
  })
}

describe('add field command', () => {
  it('opens schema autocomplete and hands the choice to the same outline flow', async () => {
    const before = await db.db.getAll('SELECT * FROM blocks ORDER BY id')
    const invocation = dispatch()
    await vi.waitFor(() => expect(getDialogQueue()).toHaveLength(1))
    const dialog = getDialogQueue()[0]
    expect(dialog.Component).toBe(AddFieldDialog)
    expect(dialog.props.owner).toBe(repo.block('owner'))
    expect(await db.db.getAll('SELECT * FROM blocks ORDER BY id')).toEqual(before)
    dialog.finalize(schema)
    await invocation
    expect(beginInlineProperty).toHaveBeenCalledWith({owner: repo.block('owner'), schema,
      ui: repo.block('ui'), scope: 'scope'})
  })

  it('cancel creates no field and never opens the property panel', async () => {
    const before = await db.db.getAll('SELECT * FROM blocks ORDER BY id')
    const invocation = dispatch()
    await vi.waitFor(() => expect(getDialogQueue()).toHaveLength(1))
    getDialogQueue()[0].finalize(null)
    await invocation
    expect(beginInlineProperty).not.toHaveBeenCalled()
    expect(await db.db.getAll('SELECT * FROM blocks ORDER BY id')).toEqual(before)
  })

  it.each(['read-only', 'cell-backed', 'deleted owner'])('refuses %s before opening the picker', async kind => {
    if (kind === 'read-only') Object.defineProperty(repo, 'isReadOnly', {value: true})
    if (kind === 'cell-backed') await db.db.execute("UPDATE workspaces SET properties_migration = 'cell'")
    if (kind === 'deleted owner') await repo.tx(tx => tx.delete('owner'), {scope: ChangeScope.BlockDefault})
    await dispatch()
    expect(getDialogQueue()).toEqual([])
    expect(beginInlineProperty).not.toHaveBeenCalled()
    expect(showError).toHaveBeenCalled()
  })

  it('reports a refused continuation visibly', async () => {
    vi.mocked(beginInlineProperty).mockRejectedValueOnce(new Error('The owner changed'))
    const invocation = dispatch()
    await vi.waitFor(() => expect(getDialogQueue()).toHaveLength(1))
    getDialogQueue()[0].finalize(schema)
    await invocation
    expect(showError).toHaveBeenCalledWith('The owner changed')
  })
})
