// @vitest-environment happy-dom

import {afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi} from 'vitest'
import {cleanup, render, screen, waitFor} from '@testing-library/react'
import type {ReactNode} from 'react'
import {ChangeScope} from '@/data/api'
import type {Block} from '@/data/block'
import {PAGE_TYPE} from '@/data/blockTypes'
import {topLevelBlockIdProp, typesProp} from '@/data/properties'
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
import {outlineRenderScopeId} from '@/utils/renderScope'
import {plainOutlinerPlugin} from '@/plugins/plain-outliner'
import {referencesPlugin} from '@/plugins/references'
import {addComment} from './addComment'
import {annotationsPlugin} from './index'
import {ThreadCard} from './ui'

const repoRef = vi.hoisted(() => ({current: undefined as Repo | undefined}))
const uiStateBlockRef = vi.hoisted(() => ({current: undefined as Block | undefined}))

vi.mock('@/context/repo.tsx', () => ({
  useRepo: () => {
    if (!repoRef.current) throw new Error('test repo not initialised')
    return repoRef.current
  },
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

// The embedded subtree renders at once, with no viewport to scroll into.
vi.mock('@/components/util/LazyViewportMount.tsx', () => ({
  LazyViewportMount: ({children}: {children: ReactNode}) => <>{children}</>,
}))

const WS = 'ws'
const EMBEDDED = '22222222-2222-4222-8222-222222222222'

describe('read-mode highlights rendered by the comment UI', () => {
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
        annotationsPlugin,
      ],
    }).repo
    repo.setActiveWorkspaceId(WS)
    repoRef.current = repo
    await repo.tx(async tx => {
      await tx.create({id: 'page', workspaceId: WS, parentId: null, orderKey: 'a0', content: 'Notes',
        properties: {[typesProp.name]: [PAGE_TYPE]}})
      await tx.create({id: 'host', workspaceId: WS, parentId: 'page', orderKey: 'a0',
        content: `a quote then !((${EMBEDDED})) here`})
      await tx.create({id: EMBEDDED, workspaceId: WS, parentId: null, orderKey: 'a1', content: 'Embedded body'})
      await tx.create({id: 'embedded-child', workspaceId: WS, parentId: EMBEDDED, orderKey: 'a0', content: 'Embedded child'})
      await tx.create({id: 'ui-state', workspaceId: WS, parentId: null, orderKey: 'a2',
        properties: {[topLevelBlockIdProp.name]: topLevelBlockIdProp.codec.encode('page')}})
    }, {scope: ChangeScope.BlockDefault})
    uiStateBlockRef.current = repo.block('ui-state')
  })

  afterEach(() => {
    cleanup()
    repoRef.current = undefined
    uiStateBlockRef.current = undefined
  })

  const renderInOutline = (node: ReactNode) => render(
    <AppRuntimeContextProvider value={repo.facetRuntime!}>
      <BlockContextProvider initialValue={{panelId: 'panel', scopeRootId: 'page', renderScopeId: outlineRenderScopeId('page')}}>
        <ActiveContextsProvider>{node}</ActiveContextsProvider>
      </BlockContextProvider>
    </AppRuntimeContextProvider>,
  )

  it('draws a new highlight and leaves the embed in the content mounted', async () => {
    renderInOutline(<DefaultBlockRenderer block={repo.block('host')}/>)
    const child = await screen.findByText('Embedded child')
    const box = document.querySelector('.blockembed')!
    const shell = box.querySelector(`[data-block-id="${EMBEDDED}"][data-block-shell]`)!
    expect(shell).toBeTruthy()
    expect(document.querySelector('mark')).toBeNull()

    await addComment(repo, {targetId: 'host', quote: 'quote'})

    await waitFor(() => expect(document.querySelector('mark')?.textContent).toBe('quote'))
    expect([box, shell, child].map(el => el.isConnected)).toEqual([true, true, true])
  })

  it('draws the highlights on a comment inside its card', async () => {
    const {threadId, commentId} = await addComment(repo, {targetId: 'host', comment: 'a phrase worth keeping'})
    renderInOutline(
      <ThreadCard thread={{id: threadId, open: true, anchor: {kind: 'block'}, suggestion: false, commentCount: 1, createdAt: 0}}/>,
    )
    await screen.findByText('a phrase worth keeping')
    expect(document.querySelector('mark')).toBeNull()

    await addComment(repo, {targetId: commentId!, quote: 'phrase'})

    await waitFor(() => expect(document.querySelector('mark')?.textContent).toBe('phrase'))
  })
})
