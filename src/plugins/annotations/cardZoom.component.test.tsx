// @vitest-environment happy-dom

import {afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi} from 'vitest'
import {act, cleanup, fireEvent, render, screen, waitFor, within} from '@testing-library/react'
import type {ReactNode} from 'react'
import {ChangeScope} from '@/data/api'
import type {Repo} from '@/data/repo'
import {createTestDb, resetTestDb, type TestDb} from '@/data/test/createTestDb'
import {createTestRepo} from '@/data/test/createTestRepo'
import {BlockContextProvider} from '@/context/block'
import {kernelPropertyUiExtension} from '@/components/propertyEditors/typesPropertyUi'
import {kernelValuePresetsExtension} from '@/components/propertyEditors/kernelValuePresets'
import {DefaultBlockRenderer} from '@/components/renderer/DefaultBlockRenderer'
import {defaultEditorInteractionExtension} from '@/editor/defaultInteractions'
import {defaultRenderersExtension} from '@/extensions/defaultRenderers'
import {BLOCK_BULLET_ATTRIBUTE} from '@/extensions/blockInteraction'
import {actionContextsFacet} from '@/extensions/core'
import {AppRuntimeContextProvider} from '@/extensions/runtimeContext'
import {ActiveContextsProvider} from '@/shortcuts/ActiveContexts'
import {defaultActionContextConfigs} from '@/shortcuts/defaultContexts'
import {panelRenderScopeId} from '@/utils/renderScope'
import {plainOutlinerPlugin} from '@/plugins/plain-outliner'
import {referencesPlugin} from '@/plugins/references'
import {zoomCrumbs} from './cardZoom'
import {annotationsPlugin} from './index'
import {createThread} from './threads'
import {
  __resetCardZoomsForTesting,
  cardRenderScopeId,
  peekCardZoom,
  setCardZoom,
  toggleThreadsExpanded,
  viewKey,
} from './uiStore'

const WS = 'ws'
const PANEL = 'ui-state'
/** The inline expansion is module state, toggled on once for the file. */
let expandedOnce = false
const repoRef = vi.hoisted(() => ({current: undefined as Repo | undefined}))
const uiStateBlockRef = vi.hoisted(() => ({current: undefined as import('@/data/block').Block | undefined}))

vi.mock('@/context/repo.tsx', () => ({
  useRepo: () => {
    if (!repoRef.current) throw new Error('test repo not initialised')
    return repoRef.current
  },
}))

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

describe('zoomCrumbs', () => {
  const chain = [{id: 'reply', content: 'Yes.\nSecond line'}, {id: 'comment', content: 'Is it confirmed?'}, {id: 'T', content: ''}, {id: 'page', content: 'Comments'}]

  it('lists the comments between the root and the zoomed block, outermost first', () => {
    expect(zoomCrumbs(chain, 'T')).toEqual([{id: 'comment', label: 'Is it confirmed?'}, {id: 'reply', label: 'Yes.'}])
  })

  it('is empty for a first-level comment, and null for a block outside the thread', () => {
    expect(zoomCrumbs(chain.slice(2), 'T')).toEqual([])
    expect(zoomCrumbs(chain, 'other')).toBeNull()
  })
})

// A render with its comments resolved and mounted measures ~250ms alone.
describe('a card zoomed into a comment', {timeout: 20_000}, () => {
  let db: TestDb
  let repo: Repo
  let ids: {threadId: string; comment: string; reply: string; nested: string; sibling: string}
  const panelScope = panelRenderScopeId(PANEL, 'page')
  let cardScope: string

  beforeAll(async () => { db = await createTestDb() })
  afterAll(async () => { await db.cleanup() })

  beforeEach(async () => {
    await resetTestDb(db.db)
    __resetCardZoomsForTesting()
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
        ...defaultActionContextConfigs.map(config => actionContextsFacet.of(config)),
        annotationsPlugin,
      ],
    }).repo
    repoRef.current = repo
    repo.setActiveWorkspaceId(WS)
    await repo.tx(async tx => {
      await tx.create({id: 'page', workspaceId: WS, parentId: null, orderKey: 'a0', content: 'Notes'})
      await tx.create({id: 'target', workspaceId: WS, parentId: 'page', orderKey: 'a0', content: 'A paragraph.'})
      await tx.create({id: PANEL, workspaceId: WS, parentId: null, orderKey: 'a1'})
    }, {scope: ChangeScope.BlockDefault})
    uiStateBlockRef.current = repo.block(PANEL)
    const {threadId, commentId} = await createThread(repo, {targetId: 'target', anchor: null, comment: 'First comment'})
    const reply = await repo.mutate.createChild({parentId: commentId!, content: 'A reply'})
    const nested = await repo.mutate.createChild({parentId: reply, content: 'A nested reply'})
    const sibling = await repo.mutate.createChild({parentId: threadId, content: 'Second comment'})
    ids = {threadId, comment: commentId!, reply, nested, sibling}
    cardScope = cardRenderScopeId('comments', panelScope, threadId)
    if (!expandedOnce) toggleThreadsExpanded(viewKey(panelScope, 'target'))
    expandedOnce = true
  })

  afterEach(() => {
    cleanup()
    repoRef.current = undefined
    uiStateBlockRef.current = undefined
  })

  const renderCard = async () => {
    render(
      <AppRuntimeContextProvider value={repo.facetRuntime!}>
        <ActiveContextsProvider>
          <BlockContextProvider initialValue={{panelId: PANEL, scopeRootId: 'page', renderScopeId: panelScope}}>
            <DefaultBlockRenderer block={repo.block('target')}/>
          </BlockContextProvider>
        </ActiveContextsProvider>
      </AppRuntimeContextProvider>,
    )
    await waitFor(() => expect(row(ids.nested)).not.toBeNull())
    return within(screen.getByTestId('comment-thread'))
  }

  const row = (id: string) =>
    screen.queryByTestId('comment-thread')?.querySelector(`[data-block-shell][data-block-id="${id}"]`) ?? null

  it('shows that comment’s subtree alone, under crumbs that lead back out', async () => {
    const card = await renderCard()

    act(() => setCardZoom(cardScope, ids.reply))

    await waitFor(() => expect(row(ids.comment)).toBeNull())
    expect(row(ids.sibling)).toBeNull()
    expect(row(ids.threadId)).toBeNull()
    expect(row(ids.reply)).not.toBeNull()
    expect(row(ids.nested)).not.toBeNull()
    const crumbs = within(card.getByRole('navigation'))

    fireEvent.click(await crumbs.findByRole('button', {name: 'First comment'}))
    await waitFor(() => expect(row(ids.comment)).not.toBeNull())
    expect(row(ids.sibling)).toBeNull()

    fireEvent.click(within(card.getByRole('navigation')).getByRole('button', {name: 'Thread'}))
    await waitFor(() => expect(row(ids.sibling)).not.toBeNull())
    expect(card.queryByRole('navigation')).toBeNull()
  })

  it('a click on a comment’s bullet zooms the card into it', async () => {
    await renderCard()

    fireEvent.click(row(ids.reply)!.querySelector(`[${BLOCK_BULLET_ATTRIBUTE}]`)!)

    await waitFor(() => expect(peekCardZoom(cardScope)).toBe(ids.reply))
    await waitFor(() => expect(row(ids.sibling)).toBeNull())
  })

  it('shows the whole thread once the zoomed comment is deleted', async () => {
    await renderCard()
    act(() => setCardZoom(cardScope, ids.reply))
    await waitFor(() => expect(row(ids.sibling)).toBeNull())

    await act(async () => { await repo.mutate.delete({id: ids.reply}) })

    await waitFor(() => expect(row(ids.sibling)).not.toBeNull())
  })
})
