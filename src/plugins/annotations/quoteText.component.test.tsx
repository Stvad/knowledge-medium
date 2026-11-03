// @vitest-environment happy-dom

import {afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi} from 'vitest'
import {cleanup, render, screen, waitFor, within} from '@testing-library/react'
import type {ReactNode} from 'react'
import {ChangeScope} from '@/data/api'
import type {Block} from '@/data/block'
import {PAGE_TYPE} from '@/data/blockTypes'
import {aliasesProp, typesProp} from '@/data/properties'
import type {Repo} from '@/data/repo'
import {createTestDb, resetTestDb, type TestDb} from '@/data/test/createTestDb'
import {createTestRepo} from '@/data/test/createTestRepo'
import {BlockContextProvider} from '@/context/block'
import {kernelPropertyUiExtension} from '@/components/propertyEditors/typesPropertyUi'
import {kernelValuePresetsExtension} from '@/components/propertyEditors/kernelValuePresets'
import {defaultEditorInteractionExtension} from '@/editor/defaultInteractions'
import {defaultRenderersExtension} from '@/extensions/defaultRenderers'
import {AppRuntimeContextProvider} from '@/extensions/runtimeContext'
import {ActiveContextsProvider} from '@/shortcuts/ActiveContexts'
import {panelRenderScopeId} from '@/utils/renderScope'
import {plainOutlinerPlugin} from '@/plugins/plain-outliner'
import {referencesPlugin} from '@/plugins/references'
import {backlinksDataExtension} from '@/plugins/backlinks/dataExtension'
import {addComment} from './addComment'
import {annotationsPlugin} from './index'
import {ThreadCard} from './ui'

const repoRef = vi.hoisted(() => ({current: undefined as Repo | undefined}))
const uiStateBlockRef = vi.hoisted(() => ({current: undefined as Block | undefined}))

vi.mock('@/components/Login.tsx', () => ({useUser: () => ({id: 'alex', name: 'Alex'})}))

vi.mock('@/context/repo.tsx', () => ({
  useRepo: () => {
    if (!repoRef.current) throw new Error('test repo not initialised')
    return repoRef.current
  },
}))

vi.mock('@/data/globalState.ts', async () => {
  const actual = await vi.importActual<typeof import('@/data/globalState.js')>('@/data/globalState.ts')
  const properties = await vi.importActual<typeof import('@/data/properties')>('@/data/properties')
  const uiStateBlock = () => uiStateBlockRef.current!
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

vi.mock('@/components/util/LazyViewportMount.tsx', () => ({
  LazyViewportMount: ({children}: {children: ReactNode}) => <>{children}</>,
}))

const WS = 'ws'
const REFERENCED = '33333333-3333-4333-8333-333333333333'
const QUOTE = `see [[Launch plan]] and ((${REFERENCED})) after`

describe('a thread card’s quote', () => {
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
        backlinksDataExtension,
        annotationsPlugin,
      ],
    }).repo
    repo.setActiveWorkspaceId(WS)
    repoRef.current = repo
    await repo.tx(async tx => {
      await tx.create({id: 'page', workspaceId: WS, parentId: null, orderKey: 'a0', content: 'Notes',
        properties: {[typesProp.name]: [PAGE_TYPE]}})
      await tx.create({id: 'target', workspaceId: WS, parentId: 'page', orderKey: 'a0', content: `Text, ${QUOTE} the end.`})
      await tx.create({id: REFERENCED, workspaceId: WS, parentId: null, orderKey: 'a1', content: 'Referenced words'})
      await tx.create({id: 'launch', workspaceId: WS, parentId: null, orderKey: 'a3', content: 'Launch plan',
        properties: {[typesProp.name]: [PAGE_TYPE], [aliasesProp.name]: aliasesProp.codec.encode(['Launch plan'])}})
      await tx.create({id: 'ui-state', workspaceId: WS, parentId: null, orderKey: 'a2'})
    }, {scope: ChangeScope.BlockDefault})
    uiStateBlockRef.current = repo.block('ui-state')
  })

  afterEach(() => {
    cleanup()
    repoRef.current = undefined
    uiStateBlockRef.current = undefined
  })

  it('renders the references it quotes as links', async () => {
    const {threadId} = await addComment(repo, {targetId: 'target', quote: QUOTE, comment: 'A note'})
    render(
      <AppRuntimeContextProvider value={repo.facetRuntime!}>
        <BlockContextProvider initialValue={{panelId: 'panel', scopeRootId: 'page', renderScopeId: panelRenderScopeId('panel', 'page')}}>
          <ActiveContextsProvider>
            <ThreadCard thread={{id: threadId, open: true, anchor: {kind: 'range', quote: QUOTE}, suggestion: false, commentCount: 1, quoterCount: 0, createdAt: 0}}/>
          </ActiveContextsProvider>
        </BlockContextProvider>
      </AppRuntimeContextProvider>,
    )
    const card = await screen.findByTestId('comment-thread')
    const blockRef = await within(card).findByRole('link', {name: 'Referenced words'})
    expect(blockRef.getAttribute('href')).toMatch(new RegExp(`${REFERENCED}$`))
    await waitFor(() => expect(within(card).getAllByRole('link').map(link => link.textContent)).toContain('Launch plan'))
    expect(card.textContent).not.toContain('((')
  })
})
