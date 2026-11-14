// @vitest-environment happy-dom
import {Suspense} from 'react'
import {act, cleanup, render} from '@testing-library/react'
import {EditorView} from '@codemirror/view'
import {afterAll, afterEach, beforeAll, beforeEach, expect, it, vi} from 'vitest'
import {ChangeScope} from '@/data/api'
import {createTestDb, resetTestDb, type TestDb} from '@/data/test/createTestDb'
import {createTestRepo} from '@/data/test/createTestRepo'
import {focusBlock, propertyNameProp} from '@/data/properties'
import {propertyDefinitionBlockId} from '@/data/definitionSeeds'
import {resolveFacetRuntimeSync} from '@/facets/facet'
import {AppRuntimeContextProvider} from '@/extensions/runtimeContext'
import {ActiveContextsProvider} from '@/shortcuts/ActiveContexts'
import {BlockContextProvider} from '@/context/block'
import {RepoContext} from '@/context/repo'
import {BlockEditor} from '@/components/BlockEditor'
import {showError} from '@/utils/toast'

const WS = 'test-name-editor'
vi.mock('@/components/Login.tsx', () => ({useUser: () => ({id: 'user'})}))
vi.mock('@/utils/toast', () => ({showError: vi.fn()}))
const swallowSelectionChange = (event: Event) => event.stopImmediatePropagation()
let db: TestDb
beforeAll(async () => { db = await createTestDb() })
afterAll(async () => { await db.cleanup() })
beforeEach(async () => {
  await resetTestDb(db.db)
  vi.clearAllMocks()
  window.addEventListener('selectionchange', swallowSelectionChange, true)
})
afterEach(() => {
  cleanup()
  window.removeEventListener('selectionchange', swallowSelectionChange, true)
})

it('shows a visible error for a refused property-name value edit and preserves stored content', async () => {
  await db.db.execute(`INSERT INTO workspaces
    (id, name, owner_user_id, create_time, update_time, encryption_mode, properties_migration)
    VALUES (?, 'test', 'user', 1, 1, 'none', 'children')`, [WS])
  const {repo} = createTestRepo({db: db.db})
  repo.setActiveWorkspaceId(WS)
  await repo.tx(async tx => {
    await tx.create({id: 'panel', workspaceId: WS, parentId: null, orderKey: 'a0'})
    await tx.create({id: 'definition', workspaceId: WS, parentId: null, orderKey: 'a1',
      properties: {[propertyNameProp.name]: 'original'}})
  }, {scope: ChangeScope.BlockDefault})
  const field = (await repo.query.children({id: 'definition', propertyChildren: 'all'}).load())!
    .find(row => row.referenceTargetId === propertyDefinitionBlockId(WS, propertyNameProp.seedKey!))!
  const value = (await repo.query.children({id: field.id, propertyChildren: 'all'}).load())![0]!
  await focusBlock(repo.block('panel'), value.id, {edit: true, renderScopeId: 'test-scope'})
  render(<RepoContext value={repo}>
    <AppRuntimeContextProvider value={resolveFacetRuntimeSync([])}>
      <ActiveContextsProvider><BlockContextProvider initialValue={{panelId: 'panel', renderScopeId: 'test-scope'}}>
        <Suspense fallback={null}><BlockEditor block={repo.block(value.id)}/></Suspense>
      </BlockContextProvider></ActiveContextsProvider>
    </AppRuntimeContextProvider>
  </RepoContext>)
  await vi.waitFor(() => expect(document.querySelector('.cm-editor')).not.toBeNull())
  const view = EditorView.findFromDOM(document.querySelector<HTMLElement>('.cm-editor')!)!
  act(() => view.dispatch({changes: {from: 0, to: view.state.doc.length, insert: '[[Other]]'}}))
  await vi.waitFor(() => expect(showError).toHaveBeenCalledWith(expect.stringMatching(/reference|grammar/i)))
  expect((await repo.block(value.id).load())?.content).toBe('original')
  expect(await repo.block('definition').get(propertyNameProp)).toBe('original')
})
