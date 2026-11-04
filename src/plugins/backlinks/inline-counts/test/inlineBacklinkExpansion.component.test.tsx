// @vitest-environment happy-dom

import {afterAll, afterEach, beforeAll, beforeEach, describe, it, vi} from 'vitest'
import {act, cleanup, render, screen} from '@testing-library/react'
import type {ReactNode} from 'react'
import {ChangeScope} from '@/data/api'
import type {Block} from '@/data/block'
import type {Repo} from '@/data/repo'
import {createTestDb, resetTestDb, type TestDb} from '@/data/test/createTestDb'
import {createTestRepo} from '@/data/test/createTestRepo'
import {BlockContextProvider} from '@/context/block'
import {kernelPropertyUiExtension} from '@/components/propertyEditors/typesPropertyUi'
import {kernelValuePresetsExtension} from '@/components/propertyEditors/kernelValuePresets'
import {DefaultBlockRenderer} from '@/components/renderer/DefaultBlockRenderer'
import {defaultEditorInteractionExtension} from '@/editor/defaultInteractions'
import {defaultRenderersExtension} from '@/extensions/defaultRenderers'
import {AppRuntimeContextProvider} from '@/extensions/runtimeContext'
import {ActiveContextsProvider} from '@/shortcuts/ActiveContexts'
import {waitForRenderOrder} from '@/test/domOrder'
import {panelRenderScopeId} from '@/utils/renderScope'
import {plainOutlinerPlugin} from '@/plugins/plain-outliner'
import {referencesPlugin} from '@/plugins/references'
import {backlinksPlugin} from '@/plugins/backlinks'
import {backlinksViewPlugin} from '@/plugins/backlinks-view'
import {topLevelBlockIdProp} from '@/data/properties'
import {toggleBacklinkExpansion} from '../expansionStore'

const WS = 'ws'
const TARGET = '11111111-1111-4111-8111-111111111111'
const CHILD = 'A child of the referenced block.'
const REFERRER = 'A note that points at it:'
const repoRef = vi.hoisted(() => ({current: undefined as Repo | undefined}))
const uiStateBlockRef = vi.hoisted(() => ({current: undefined as Block | undefined}))

vi.mock('@/context/repo.tsx', () => ({
  useRepo: () => {
    if (!repoRef.current) throw new Error('test repo not initialised')
    return repoRef.current
  },
}))

vi.mock('@/components/Login.tsx', () => ({useUser: () => ({id: 'alex', name: 'Alex'})}))

vi.mock('@/components/util/LazyViewportMount.tsx', () => ({
  LazyViewportMount: ({children}: {children: ReactNode}) => <>{children}</>,
}))

vi.mock('@/data/globalState.ts', async () => {
  const actual = await vi.importActual<typeof import('@/data/globalState.js')>('@/data/globalState.ts')
  const properties = await vi.importActual<typeof import('@/data/properties')>('@/data/properties')
  const uiStateBlock = () => {
    if (!uiStateBlockRef.current) throw new Error('test UI state block not initialised')
    return uiStateBlockRef.current
  }
  return {
    ...actual,
    useUIStateBlock: uiStateBlock,
    useUIStateProperty: <T,>(schema: import('@/data/api').PropertySchema<T>): [T, (value: T) => void] => [
      uiStateBlock().peekProperty(schema) ?? schema.defaultValue,
      (value: T) => { void uiStateBlock().set(schema, value) },
    ],
    useInFocus: (blockId: string): boolean => properties.isFocusedBlock(uiStateBlock(), blockId),
    useInEditMode: (): boolean => false,
    useIsSelected: (): boolean => false,
  }
})

describe('where a block\'s backlinks render', () => {
  let db: TestDb
  let repo: Repo

  beforeAll(async () => { db = await createTestDb() })
  afterAll(async () => { await db.cleanup() })

  beforeEach(async () => {
    await resetTestDb(db.db)
    repo = createTestRepo({
      db: db.db,
      user: {id: 'alex', name: 'Alex'},
      extensions: [
        kernelPropertyUiExtension,
        kernelValuePresetsExtension,
        defaultEditorInteractionExtension,
        defaultRenderersExtension,
        plainOutlinerPlugin,
        referencesPlugin,
        backlinksPlugin,
        backlinksViewPlugin,
      ],
    }).repo
    repoRef.current = repo
    repo.setActiveWorkspaceId(WS)
    await repo.tx(async tx => {
      await tx.create({id: 'page', workspaceId: WS, parentId: null, orderKey: 'a0', content: 'Notes'})
      await tx.create({id: TARGET, workspaceId: WS, parentId: 'page', orderKey: 'a0', content: 'The referenced block'})
      await tx.create({id: 'child', workspaceId: WS, parentId: TARGET, orderKey: 'a0', content: CHILD})
      await tx.create({id: 'ui-state', workspaceId: WS, parentId: null, orderKey: 'a1'})
    }, {scope: ChangeScope.BlockDefault})
    await repo.tx(async tx => {
      await tx.create({id: 'referrer', workspaceId: WS, parentId: 'page', orderKey: 'a1', content: `${REFERRER} ((${TARGET}))`})
    }, {scope: ChangeScope.BlockDefault})
    uiStateBlockRef.current = repo.block('ui-state')
  })

  afterEach(() => {
    cleanup()
    repoRef.current = undefined
    uiStateBlockRef.current = undefined
  })

  const renderTarget = (scopeRootId: string) => act(async () => {
    render(
      <AppRuntimeContextProvider value={repo.facetRuntime!}>
        <ActiveContextsProvider>
          <BlockContextProvider initialValue={{panelId: 'panel', scopeRootId, renderScopeId: panelRenderScopeId('panel', scopeRootId)}}>
            <DefaultBlockRenderer block={repo.block(TARGET)}/>
          </BlockContextProvider>
        </ActiveContextsProvider>
      </AppRuntimeContextProvider>,
    )
  })

  it('an inline expansion goes directly under the block, ahead of its children', async () => {
    await renderTarget('page')
    await screen.findByText(CHILD)
    await act(async () => toggleBacklinkExpansion(TARGET))
    try {
      await screen.findByText(REFERRER, {exact: false})
      await waitForRenderOrder(() => screen.getByText(REFERRER, {exact: false}), () => screen.getByText(CHILD))
    } finally {
      await act(async () => toggleBacklinkExpansion(TARGET))
    }
  }, 20_000)

  it('the focal block keeps its linked references after its children', async () => {
    await repo.block('ui-state').set(topLevelBlockIdProp, TARGET)
    await renderTarget(TARGET)
    await screen.findByText(REFERRER, {exact: false})
    await waitForRenderOrder(() => screen.getByText(CHILD), () => screen.getByText(REFERRER, {exact: false}))
  }, 20_000)
})
