// @vitest-environment happy-dom
/** The block being edited, moved to another parent: between the commit that
 *  moves it in the cache and the reload of the lists that show it, the outline
 *  draws it once, at its new parent, and that one editor keeps the focus. */
import { Suspense } from 'react'
import { act, cleanup, render, waitFor } from '@testing-library/react'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { ChangeScope, type User } from '@/data/api'
import { kernelDataExtension } from '@/data/kernelDataExtension'
import { focusBlock, requestEditorFocus } from '@/data/properties'
import type { Repo } from '@/data/repo'
import { createTestDb, resetTestDb, type TestDb } from '@/data/test/createTestDb'
import { createTestRepo } from '@/data/test/createTestRepo'
import { resolveFacetRuntimeSync, type FacetRuntime } from '@/facets/facet'
import { AppRuntimeContextProvider } from '@/extensions/runtimeContext'
import { actionContextsFacet } from '@/extensions/core'
import { defaultRenderersExtension } from '@/extensions/defaultRenderers'
import { ActiveContextsProvider } from '@/shortcuts/ActiveContexts'
import { defaultActionContextConfigs } from '@/shortcuts/defaultContexts'
import { BlockContextProvider } from '@/context/block'
import { RepoContext } from '@/context/repo'
import { BlockComponent } from '@/components/BlockComponent'
import { __resetLazyMountCachesForTesting } from '@/components/util/LazyViewportMount'
import { __resetLazyMountRegistryForTesting } from '@/components/util/lazyMountRegistry'
import { kernelPropertyUiExtension } from '@/components/propertyEditors/typesPropertyUi'
import { kernelValuePresetsExtension } from '@/components/propertyEditors/kernelValuePresets'
import { defaultEditorInteractionExtension } from '@/editor/defaultInteractions'
import { plainOutlinerPlugin } from '@/plugins/plain-outliner'

const USER: User = {id: 'user-1', name: 'Alice'}
vi.mock('@/components/Login.tsx', () => ({useUser: () => USER}))

const WS = 'ws-focused-move'
const PANEL = 'panel'
const PAGE = 'page'

let sharedDb: TestDb
let repo: Repo
let runtime: FacetRuntime
beforeAll(async () => {
  Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', {configurable: true, value: vi.fn()})
  Object.assign(Range.prototype, {getClientRects: () => [], getBoundingClientRect: () => new DOMRect()})
  sharedDb = await createTestDb()
})
afterAll(async () => { await sharedDb.cleanup() })
afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  __resetLazyMountRegistryForTesting()
  __resetLazyMountCachesForTesting()
})
beforeEach(async () => {
  // No observer: every lazy row mounts at once.
  vi.stubGlobal('IntersectionObserver', undefined)
  vi.stubGlobal('matchMedia', (query: string) => ({
    matches: false, media: query, addEventListener: () => {}, removeEventListener: () => {},
    addListener: () => {}, removeListener: () => {}, onchange: null, dispatchEvent: () => false,
  }))
  await resetTestDb(sharedDb.db)
  repo = createTestRepo({db: sharedDb.db, user: USER}).repo
  runtime = resolveFacetRuntimeSync([
    kernelDataExtension,
    kernelPropertyUiExtension,
    kernelValuePresetsExtension,
    defaultRenderersExtension,
    defaultEditorInteractionExtension,
    plainOutlinerPlugin,
    defaultActionContextConfigs.map(config => actionContextsFacet.of(config, {source: 'test'})),
  ])
  repo.setFacetRuntime(runtime)
  repo.setActiveWorkspaceId(WS)
  await repo.tx(async tx => {
    for (const [id, parentId, orderKey, content] of [
      [PANEL, null, 'a0', ''], [PAGE, null, 'a1', 'page'],
      ['first', PAGE, 'a0', 'first'], ['first-child', 'first', 'a0', 'first child'], ['moved', PAGE, 'a1', 'moved text'],
    ] as const) {
      await tx.create({id, workspaceId: WS, parentId, orderKey, content})
    }
  }, {scope: ChangeScope.BlockDefault})
})

const mount = () => render(
  <RepoContext value={repo}>
    <AppRuntimeContextProvider value={runtime}>
      <ActiveContextsProvider>
        <Suspense fallback={null}>
          <BlockContextProvider initialValue={{panelId: PANEL}}>
            <BlockComponent blockId={PAGE}/>
          </BlockContextProvider>
        </Suspense>
      </ActiveContextsProvider>
    </AppRuntimeContextProvider>
  </RepoContext>,
)

const editorsOf = (id: string) =>
  [...document.querySelectorAll<HTMLElement>(`[data-block-id="${id}"] .cm-editor`)]
    .filter(editor => editor.closest('[data-block-id]')?.getAttribute('data-block-id') === id)

const parentBlockOf = (element: Element) =>
  element.closest('[data-block-id]')?.parentElement?.closest('[data-block-id]')?.getAttribute('data-block-id')

describe('the block being edited, moved under its previous sibling', () => {
  it('is drawn once, at its new parent, and its editor takes the focus request', async () => {
    await focusBlock(repo.block(PANEL), 'moved', {edit: true})
    mount()
    await waitFor(() => expect(editorsOf('moved')).toHaveLength(1))
    await waitFor(() => expect(document.querySelector('[data-block-id="first-child"]')).not.toBeNull())
    expect(parentBlockOf(editorsOf('moved')[0]!)).toBe(PAGE)

    // What an indent's commit does before any list reloads: the cache has the
    // row under its new parent. Nothing here invalidates a child list.
    act(() => {
      const moved = repo.block('moved').peek()!
      repo.cache.setSnapshot({...moved, parentId: 'first', orderKey: 'a1'})
    })
    expect(repo.query.childIds({id: PAGE, hydrate: true, propertyChildren: 'none'}).peek()).toContain('moved')

    await waitFor(() => expect(editorsOf('moved').map(parentBlockOf)).toEqual(['first']))
    const [editor] = editorsOf('moved')
    expect(editor!.querySelector('.cm-content')?.textContent).toBe('moved text')

    act(() => requestEditorFocus(repo.block(PANEL)))
    await waitFor(() => expect(editor!.contains(document.activeElement)).toBe(true))
  })
})
