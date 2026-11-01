// @vitest-environment happy-dom

import {act, cleanup, fireEvent, render, screen, waitFor, within} from '@testing-library/react'
import {Suspense, type ReactNode} from 'react'
import {afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi} from 'vitest'
import {ChangeScope} from '@/data/api'
import type {Block} from '@/data/block'
import {PAGE_TYPE} from '@/data/blockTypes'
import {topLevelBlockIdProp, typesProp} from '@/data/properties'
import type {Repo} from '@/data/repo'
import {userPageBlockId} from '@/data/stateBlocks'
import {createTestDb, resetTestDb, type TestDb} from '@/data/test/createTestDb'
import {createTestRepo} from '@/data/test/createTestRepo'
import {kernelDataExtension} from '@/data/kernelDataExtension'
import {resolveAppRuntimeSync} from '@/facets/resolveAppRuntime'
import {kernelPropertyUiExtension} from '@/components/propertyEditors/typesPropertyUi'
import {kernelValuePresetsExtension} from '@/components/propertyEditors/kernelValuePresets'
import {BlockContextProvider} from '@/context/block'
import {defaultEditorInteractionExtension} from '@/editor/defaultInteractions'
import {defaultRenderersExtension} from '@/extensions/defaultRenderers'
import {AppRuntimeContextProvider} from '@/extensions/runtimeContext'
import {DialogHost} from '@/extensions/dialogAppMount'
import {ActiveContextsProvider} from '@/shortcuts/ActiveContexts'
import {defaultActionContextConfigs} from '@/shortcuts/defaultContexts'
import {actionContextsFacet} from '@/extensions/core'
import {__resetDialogsForTests} from '@/utils/dialogs'
import {panelRenderScopeId} from '@/utils/renderScope'
import {plainOutlinerPlugin} from '@/plugins/plain-outliner'
import {breadcrumbsPlugin} from '@/plugins/breadcrumbs'
import {contributorsPlugin} from '@/plugins/contributors'
import {referencesPlugin} from '@/plugins/references'
import {backlinksPlugin} from '@/plugins/backlinks'
import {LinkedReferences} from '@/plugins/backlinks/LinkedReferences'
import {annotationsPlugin} from './index'
import {CommentMargin} from './margin'
import {annotationMarginOpenProp} from './marginSchema'
import {MENTIONS_FOR_BLOCK_QUERY, mentionsForBlockQuery} from './mentionsQuery'
import {toggleShowMentions} from './uiStore'

const mocks = vi.hoisted(() => ({
  repoRef: {current: undefined as Repo | undefined},
  uiStateBlockRef: {current: undefined as Block | undefined},
  useOpenBlock: vi.fn(),
  opened: vi.fn(),
}))

vi.mock('@/context/repo.tsx', () => ({
  useRepo: () => {
    if (!mocks.repoRef.current) throw new Error('test repo not initialised')
    return mocks.repoRef.current
  },
}))

vi.mock('@/components/Login.tsx', async importOriginal => ({
  ...await importOriginal<typeof import('@/components/Login')>(),
  useUser: () => ({id: 'alex', name: 'Alex'}),
}))

vi.mock('@/utils/navigation.js', async () => {
  const actual = await vi.importActual<typeof import('@/utils/navigation.js')>('@/utils/navigation.js')
  return {...actual, useOpenBlock: mocks.useOpenBlock}
})

vi.mock('@/components/util/LazyViewportMount.tsx', () => ({
  LazyViewportMount: ({children}: {children: ReactNode}) => <>{children}</>,
}))

vi.mock('@/data/globalState.ts', async () => {
  const actual = await vi.importActual<typeof import('@/data/globalState.js')>('@/data/globalState.ts')
  return {
    ...actual,
    useUIStateBlock: () => {
      if (!mocks.uiStateBlockRef.current) throw new Error('test UI state block not initialised')
      return mocks.uiStateBlockRef.current
    },
    useUIStateProperty: <T,>(schema: import('@/data/api').PropertySchema<T>): [T, (value: T) => void] => [
      mocks.uiStateBlockRef.current?.peekProperty(schema) ?? schema.defaultValue,
      value => { if (mocks.uiStateBlockRef.current) void mocks.uiStateBlockRef.current.set(schema, value) },
    ],
    useInFocus: () => false,
    useInEditMode: () => false,
    useIsSelected: () => false,
  }
})

const WS = 'ws'
const PANEL = 'mentions-panel'
const PAGE = 'mentions-page'
const TARGET = '11111111-1111-4111-8111-111111111111'
const SCOPE = panelRenderScopeId(PANEL, TARGET)
const BLOCK_DEFAULT = {scope: ChangeScope.BlockDefault}
const GEOMETRY: DOMRect = {
  x: 0, y: 0, left: 0, top: 0, right: 1200, bottom: 800,
  width: 1200, height: 800, toJSON: () => ({}),
}

let db: TestDb
let repo: Repo
let mentionsVisible = false
let originalGetBoundingClientRect: typeof HTMLElement.prototype.getBoundingClientRect
let originalResizeObserver: typeof ResizeObserver | undefined

class TestResizeObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
}

const createRuntime = (contributorsEnabled = true) => resolveAppRuntimeSync(
  [
    kernelDataExtension,
    kernelPropertyUiExtension,
    defaultActionContextConfigs.map(config => actionContextsFacet.of(config)),
    kernelValuePresetsExtension,
    defaultEditorInteractionExtension,
    defaultRenderersExtension,
    plainOutlinerPlugin,
    referencesPlugin,
    backlinksPlugin,
    breadcrumbsPlugin,
    contributorsPlugin,
    annotationsPlugin,
  ],
  {overrides: new Map([['system:contributors', contributorsEnabled]])},
)

const createRepo = () => {
  const result = createTestRepo({
    db: db.db,
    newId: () => crypto.randomUUID(),
    user: {id: 'alex', name: 'Alex'},
  }).repo
  result.setFacetRuntime(createRuntime())
  return result
}

const seedGraph = async (mentionCount: number) => {
  await repo.tx(async tx => {
    await tx.create({id: PAGE, workspaceId: WS, parentId: null, orderKey: 'a0', content: 'Mention location',
      properties: {[typesProp.name]: [PAGE_TYPE]}})
    await tx.create({id: userPageBlockId(WS, 'alex'), workspaceId: WS, parentId: null, orderKey: 'a1', content: 'Alex',
      properties: {[typesProp.name]: [PAGE_TYPE]}})
    await tx.create({id: TARGET, workspaceId: WS, parentId: PAGE, orderKey: 'a0', content: 'Target'})
    for (let index = 1; index <= mentionCount; index++) {
      await tx.create({
        id: `mention-source-${index}`,
        workspaceId: WS,
        parentId: PAGE,
        orderKey: `a${index}`,
        content: `**Mention body ${index}** and ((${TARGET}))`,
      })
    }
    await tx.create({
      id: PANEL,
      workspaceId: WS,
      parentId: null,
      orderKey: 'z0',
      properties: {
        [annotationMarginOpenProp.name]: annotationMarginOpenProp.codec.encode(true),
        [topLevelBlockIdProp.name]: topLevelBlockIdProp.codec.encode(TARGET),
      },
    })
    await tx.create({
      id: 'mentions-ui-state',
      workspaceId: WS,
      parentId: null,
      orderKey: 'z1',
      properties: {[topLevelBlockIdProp.name]: topLevelBlockIdProp.codec.encode(PAGE)},
    })
  }, BLOCK_DEFAULT)
  await repo.awaitProcessors()
  mocks.uiStateBlockRef.current = repo.block('mentions-ui-state')
}

const makeView = ({withBacklinks = false}: {withBacklinks?: boolean} = {}) => render(
  <AppRuntimeContextProvider value={repo.facetRuntime!}>
    <ActiveContextsProvider>
    <BlockContextProvider initialValue={{panelId: PANEL, scopeRootId: TARGET, renderScopeId: SCOPE}}>
      <div data-panel-id={PANEL}>
        <div data-panel-scrollport>
          <div data-block-shell data-block-id={TARGET} data-render-scope-id={SCOPE}>Target row</div>
        </div>
        <CommentMargin block={repo.block(PANEL)}/>
        {withBacklinks && <Suspense fallback="Loading references…"><LinkedReferences block={repo.block(TARGET)}/></Suspense>}
      </div>
    </BlockContextProvider>
      <DialogHost/>
    </ActiveContextsProvider>
  </AppRuntimeContextProvider>,
)

const turnMentionsOn = async () => {
  await screen.findByRole('button', {name: 'Show mentions'})
  fireEvent.click(screen.getByRole('button', {name: 'Show mentions'}))
  mentionsVisible = true
}

beforeAll(async () => { db = await createTestDb() })
afterAll(async () => { await db.cleanup() })

beforeEach(async () => {
  await resetTestDb(db.db)
  repo = createRepo()
  repo.setActiveWorkspaceId(WS)
  mocks.repoRef.current = repo
  mocks.opened.mockReset()
  mocks.useOpenBlock.mockReset().mockImplementation(target => (event: {preventDefault: () => void}) => {
    event.preventDefault()
    mocks.opened(target)
  })
  mentionsVisible = false
  originalGetBoundingClientRect = HTMLElement.prototype.getBoundingClientRect
  HTMLElement.prototype.getBoundingClientRect = function() {
    if (this.matches('[data-block-shell]')) {
      return {...GEOMETRY, right: 820, width: 820, top: 20, y: 20, bottom: 60, height: 40}
    }
    return GEOMETRY
  }
  originalResizeObserver = globalThis.ResizeObserver
  globalThis.ResizeObserver = TestResizeObserver as unknown as typeof ResizeObserver
})

afterEach(() => {
  cleanup()
  __resetDialogsForTests()
  if (mentionsVisible) toggleShowMentions(PANEL)
  mentionsVisible = false
  mocks.repoRef.current = undefined
  mocks.uiStateBlockRef.current = undefined
  HTMLElement.prototype.getBoundingClientRect = originalGetBoundingClientRect
  if (originalResizeObserver) globalThis.ResizeObserver = originalResizeObserver
  else Reflect.deleteProperty(globalThis, 'ResizeObserver')
})

describe('CommentMargin mention cards', () => {
  it('renders mention content and its author with Contributors disabled', async () => {
    await seedGraph(1)
    repo.setFacetRuntime(createRuntime(false))
    const view = makeView()
    await turnMentionsOn()

    const mention = await screen.findByLabelText('Mentions')
    await waitFor(() => expect(mention.querySelector('strong')?.textContent).toBe('Mention body 1'))
    expect(await within(mention).findByRole('link', {name: 'Alex'})).toBeVisible()
    expect(within(mention).getByRole('link', {name: 'Open mention'})).toHaveAttribute('href', '#ws/mention-source-1')
    view.unmount()
  })

  it('renders a read-only source preview, its location and author, and navigates to the source', async () => {
    await seedGraph(1)
    const view = makeView()
    await turnMentionsOn()

    const mention = await screen.findByLabelText('Mentions')
    await waitFor(() => expect(mention.querySelector('strong')?.textContent).toBe('Mention body 1'))
    expect(mention.textContent).toContain('Mention location')
    expect(mention.textContent).toContain('Alex')
    expect(mention.querySelectorAll('button, input, textarea, [role="button"]')).toHaveLength(0)
    expect(mention.querySelector('.cm-editor')).toBeNull()
    expect(screen.queryByRole('button', {name: /more$/})).toBeNull()

    const sourceLink = screen.getByRole('link', {name: 'Open mention'})
    const previewId = sourceLink.getAttribute('aria-describedby')
    expect(previewId).toBeTruthy()
    const preview = document.getElementById(previewId!)!
    expect(preview.textContent).toContain('Mention body 1')
    expect(preview.closest('[inert], [aria-hidden="true"]')).toBeNull()
    expect(sourceLink).toHaveAccessibleDescription('Mention body 1 and Target')
    const authorLink = screen.getByRole('link', {name: 'Alex'})
    expect(sourceLink.getAttribute('href')).toBe('#ws/mention-source-1')
    expect(authorLink.getAttribute('href')).not.toBe(sourceLink.getAttribute('href'))
    expect(sourceLink.contains(authorLink)).toBe(false)
    expect(mocks.opened).not.toHaveBeenCalled()
    fireEvent.click(sourceLink)
    expect(mocks.opened).toHaveBeenCalledWith({blockId: 'mention-source-1', workspaceId: WS})

    view.unmount()
  })

  it('caps source cards at three and opens all backlinks even when the focal target’s view is collapsed', async () => {
    await seedGraph(4)
    let view!: ReturnType<typeof makeView>
    await act(async () => { view = makeView({withBacklinks: true}) })
    const existingBacklinks = await screen.findByRole('button', {name: /Linked References.*4/})
    fireEvent.click(existingBacklinks)
    expect(existingBacklinks.textContent).toContain('▸')
    await turnMentionsOn()

    await screen.findByLabelText('Mentions')
    await waitFor(() => expect(screen.getAllByRole('link', {name: 'Open mention'})).toHaveLength(3))
    const more = screen.getByRole('button', {name: '1 more'})
    fireEvent.click(more)
    const dialog = await screen.findByRole('dialog', {name: 'Linked References'})
    for (let index = 1; index <= 4; index++) {
      await within(dialog).findByText(`Mention body ${index}`, {selector: 'strong'})
    }
    expect(existingBacklinks.textContent).toContain('▸')
    fireEvent.click(within(dialog).getByRole('button', {name: 'Close'}))
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())

    view.unmount()
  })

  it('walks ancestors only for the three shown mentions with fifty sources', async () => {
    await seedGraph(50)
    const ancestorReads = vi.spyOn(db.db, 'getAll')
    try {
      const view = makeView()
      await turnMentionsOn()

      const mention = await screen.findByLabelText('Mentions')
      await waitFor(() => expect(within(mention).getAllByRole('link', {name: 'Open mention'})).toHaveLength(3))
      const shownSourceIds = within(mention).getAllByRole('link', {name: 'Open mention'}).map(link =>
        link.getAttribute('href')!.split('/').at(-1)!,
      )
      const result = await repo.query[MENTIONS_FOR_BLOCK_QUERY]({workspaceId: WS, id: TARGET}).load()
      expect(result.total).toBe(50)
      expect(result.ids).toEqual(shownSourceIds)

      const ancestorSeedIds = ancestorReads.mock.calls.flatMap(([statement, params]) =>
        statement.includes('chain_start_id') ? params as string[] : [],
      )
      expect(ancestorSeedIds.length).toBeGreaterThan(0)
      expect(ancestorSeedIds).toHaveLength(3)
      expect(new Set(ancestorSeedIds)).toEqual(new Set(shownSourceIds))

      view.unmount()
    } finally {
      ancestorReads.mockRestore()
    }
  })

  it('does not dispatch the mentions query while the option is off', async () => {
    await seedGraph(1)
    const resolver = vi.spyOn(mentionsForBlockQuery, 'resolve')
    const first = makeView()
    await turnMentionsOn()
    await waitFor(() => expect(resolver).toHaveBeenCalled())
    expect(resolver).toHaveBeenCalledWith(expect.objectContaining({workspaceId: WS, id: TARGET}), expect.anything())
    first.unmount()
    toggleShowMentions(PANEL)
    mentionsVisible = false

    // A fresh Repo gives the off render a cold handle store; a cached result
    // from the proving ON render cannot make a missing query look unused.
    repo = createRepo()
    repo.setActiveWorkspaceId(WS)
    mocks.repoRef.current = repo
    mocks.uiStateBlockRef.current = repo.block('mentions-ui-state')
    resolver.mockClear()
    const dispatchQuery = vi.spyOn(repo as unknown as {dispatchQuery: (name: string) => unknown}, 'dispatchQuery')
    const second = makeView()
    await screen.findByRole('button', {name: 'Show mentions'})
    expect(screen.getByRole('button', {name: 'Show mentions'}).getAttribute('aria-pressed')).toBe('false')
    expect(dispatchQuery.mock.calls.filter(([name]) => name === MENTIONS_FOR_BLOCK_QUERY)).toHaveLength(0)
    expect(resolver).not.toHaveBeenCalled()
    second.unmount()
    resolver.mockRestore()
  })

  it('does not register an empty card for a block without mentions', async () => {
    await seedGraph(0)
    const view = makeView()
    await turnMentionsOn()
    await repo.query[MENTIONS_FOR_BLOCK_QUERY]({workspaceId: WS, id: TARGET}).load()
    expect(view.container.querySelector('[data-margin-card]')).toBeNull()
    expect(screen.queryByLabelText('Mentions')).toBeNull()
  })
})
