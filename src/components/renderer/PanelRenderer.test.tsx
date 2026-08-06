// @vitest-environment happy-dom

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { StrictMode } from 'react'
import { ChangeScope, type User } from '@/data/api'
import type { Block } from '@/data/block'
import { createTestDb, resetTestDb, type TestDb } from '@/data/test/createTestDb'
import { createTestRepo } from '@/data/test/createTestRepo'
import { Repo } from '@/data/repo'
import {
  activePanelIdProp,
  focusedBlockLocationProp,
  panelViewModeProp,
  peekFocusedBlockLocation,
  scrollTopProp,
  topLevelBlockIdProp,
} from '@/data/properties'
import { BlockContextProvider } from '@/context/block'
import { resolveFacetRuntimeSync, type FacetRuntime } from '@/facets/facet'
import { AppRuntimeContextProvider } from '@/extensions/runtimeContext'
import { PanelRenderer } from './PanelRenderer'
import { BlockComponent } from '@/components/BlockComponent.js'
import { useActionContext } from '@/shortcuts/useActionContext'
import { ActionContextTypes } from '@/shortcuts/types'
import { panelHistory } from '@/utils/panelHistory'
import { outlineRenderScopeId, panelRenderScopeId } from '@/utils/renderScope'

const repoRef = vi.hoisted(() => ({
  current: undefined as Repo | undefined,
}))

const selectionStore = vi.hoisted(() => {
  const listeners = new Set<() => void>()
  const store = {
    current: {selectedBlockIds: [] as string[], anchorBlockId: null as string | null},
    subscribe(listener: () => void) {
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    },
    set(next: {selectedBlockIds: string[]; anchorBlockId: string | null}) {
      store.current = next
      for (const listener of listeners) listener()
    },
    reset() {
      store.current = {selectedBlockIds: [], anchorBlockId: null}
      listeners.clear()
    },
  }
  return store
})

vi.mock('@/context/repo', () => ({
  useRepo: () => {
    if (!repoRef.current) throw new Error('test repo not initialised')
    return repoRef.current
  },
}))

vi.mock('@/data/globalState', async () => {
  const actual = await vi.importActual<typeof import('@/data/globalState')>('@/data/globalState')
  const {useSyncExternalStore} = await vi.importActual<typeof import('react')>('react')
  return {
    ...actual,
    useSelectionState: () => {
      const current = useSyncExternalStore(
        selectionStore.subscribe,
        () => selectionStore.current,
        () => selectionStore.current,
      )
      return [current, vi.fn()]
    },
  }
})

vi.mock('@/shortcuts/useActionContext', () => ({
  useActionContext: vi.fn(),
}))

// The aligner's own pixel math is pinned in `panelScrollAnchor.test.ts` (and
// needs real layout, which happy-dom has none of). What belongs here is which
// anchor the pane hands it — and whether it reaches for one at all.
const alignScrollportToRow = vi.hoisted(() => vi.fn(() => () => {}))
vi.mock('@/utils/panelScrollAnchor', async () => {
  const actual = await vi.importActual<typeof import('@/utils/panelScrollAnchor')>(
    '@/utils/panelScrollAnchor',
  )
  return {...actual, alignScrollportToRow}
})

vi.mock('@/components/BlockComponent.tsx', async () => {
  const {useBlockContext} = await vi.importActual<typeof import('@/context/block')>('@/context/block')
  return {
    BlockComponent: vi.fn(({blockId}: {blockId: string}) => {
      // Surface the context the top-level block render receives so tests can
      // pin the per-pane render scope and the panelViewMode threading.
      const context = useBlockContext()
      return (
        <div
          data-testid="panel-top-level-block"
          data-block-id={blockId}
          data-context-render-scope-id={typeof context.renderScopeId === 'string' ? context.renderScopeId : ''}
          data-context-view-mode={typeof context.panelViewMode === 'string' ? context.panelViewMode : ''}
        >
          <button
            type="button"
            data-testid="panel-content-control"
            onPointerDown={event => event.stopPropagation()}
          />
        </div>
      )
    }),
  }
})

const WS = 'ws-1'
const USER: User = {id: 'user-1', name: 'Alice'}

interface Harness {
  h: TestDb
  repo: Repo
  runtime: FacetRuntime
  panel: Block
}

const setup = async (): Promise<Harness> => {
  await resetTestDb(sharedDb.db)
  const h = sharedDb
  const { repo } = createTestRepo({
    db: h.db,
    user: USER,
    startSyncObserver: false,
  })
  repo.setActiveWorkspaceId(WS)
  const runtime = resolveFacetRuntimeSync([])

    await repo.tx(async tx => {
      await tx.create({
        id: 'layout-session',
        workspaceId: WS,
        parentId: null,
        orderKey: 'a0',
        content: 'Layout session',
        properties: {
          [activePanelIdProp.name]: activePanelIdProp.codec.encode('panel-a'),
        },
      })
      await tx.create({
        id: 'page-a',
        workspaceId: WS,
        parentId: null,
        orderKey: 'a1',
        content: 'Page A',
      })
      await tx.create({
        id: 'panel-a',
        workspaceId: WS,
        parentId: 'layout-session',
        orderKey: 'a2',
        content: 'Panel A',
        properties: {
          [topLevelBlockIdProp.name]: topLevelBlockIdProp.codec.encode('page-a'),
      },
    })
  }, {scope: ChangeScope.BlockDefault, description: 'create panel renderer fixture'})

  repoRef.current = repo
  return {h, repo, runtime, panel: repo.block('panel-a')}
}

let sharedDb: TestDb
beforeAll(async () => { sharedDb = await createTestDb() })
afterAll(async () => { await sharedDb.cleanup() })

describe('PanelRenderer', () => {
  let env: Harness

  beforeEach(async () => {
    selectionStore.reset()
    vi.mocked(BlockComponent).mockClear()
    vi.mocked(useActionContext).mockClear()
    alignScrollportToRow.mockClear()
    env = await setup()
  })

  afterEach(async () => {
    panelHistory.clear(env.panel.id)
    cleanup()
    repoRef.current = undefined
  })

  const renderPanel = (wideScrollSurface: boolean) =>
    render(
      <AppRuntimeContextProvider value={env.runtime}>
        <BlockContextProvider
          initialValue={{
            layoutBoundary: true,
            panelId: env.panel.id,
            wideScrollSurface,
          }}
        >
          <PanelRenderer block={env.panel}/>
        </BlockContextProvider>
      </AppRuntimeContextProvider>,
    )

  const renderPanelInLayoutSession = async (
    activePanelId: string,
    options: {canClosePanel?: boolean; trackPanelFocus?: boolean} = {},
  ) => {
    await env.repo.block('layout-session').set(activePanelIdProp, activePanelId)

    return render(
      <AppRuntimeContextProvider value={env.runtime}>
        <BlockContextProvider
          initialValue={{
            layoutBoundary: true,
            layoutSessionBlockId: 'layout-session',
            panelId: env.panel.id,
            canClosePanel: options.canClosePanel,
            trackPanelFocus: options.trackPanelFocus,
          }}
        >
          <PanelRenderer block={env.panel}/>
        </BlockContextProvider>
      </AppRuntimeContextProvider>,
    )
  }

  it('constrains content inside a wide scroll surface', async () => {
    renderPanel(true)

    const contentFrame = (await screen.findByTestId('panel-top-level-block')).parentElement
    expect(contentFrame?.className).toContain('mx-auto')
    expect(contentFrame?.className).toContain('max-w-3xl')
  })

  it('lets wide-surface chrome empty space pass clicks through to content', async () => {
    renderPanel(true)

    const backButton = await screen.findByLabelText('Back')
    expect(backButton.className).toContain('pointer-events-auto')
    expect(backButton.parentElement?.className).toContain('pointer-events-none')
    expect(backButton.parentElement?.parentElement?.className).toContain('pointer-events-none')
  })

  it('activates the panel from history chrome pointer events', async () => {
    panelHistory.push(env.panel.id, {blockId: 'page-prev'})
    await renderPanelInLayoutSession('panel-b')
    const sessionBlock = env.repo.block('layout-session')

    fireEvent.pointerDown(await screen.findByLabelText('Back'))

    await vi.waitFor(() => {
      expect(sessionBlock.peekProperty(activePanelIdProp)).toBe(env.panel.id)
    })
  })

  it('activates the panel from history chrome focus when focus tracking is enabled', async () => {
    panelHistory.push(env.panel.id, {blockId: 'page-prev'})
    await renderPanelInLayoutSession('panel-b', {trackPanelFocus: true})
    const sessionBlock = env.repo.block('layout-session')

    fireEvent.focus(await screen.findByLabelText('Back'))

    await vi.waitFor(() => {
      expect(sessionBlock.peekProperty(activePanelIdProp)).toBe(env.panel.id)
    })
  })

  it('activates the panel from content capture when child controls stop propagation', async () => {
    await renderPanelInLayoutSession('panel-b')
    const sessionBlock = env.repo.block('layout-session')

    fireEvent.pointerDown(await screen.findByTestId('panel-content-control'))

    await vi.waitFor(() => {
      expect(sessionBlock.peekProperty(activePanelIdProp)).toBe(env.panel.id)
    })
  })

  it('does not activate the panel from close pointer events', async () => {
    await renderPanelInLayoutSession('panel-b', {canClosePanel: true})
    const txSpy = vi.spyOn(env.repo, 'tx')

    fireEvent.pointerDown(await screen.findByLabelText('Close panel'))

    expect(txSpy).not.toHaveBeenCalled()
  })

  it('does not activate the panel from close focus events', async () => {
    await renderPanelInLayoutSession('panel-b', {canClosePanel: true, trackPanelFocus: true})
    const sessionBlock = env.repo.block('layout-session')

    fireEvent.focus(await screen.findByLabelText('Close panel'))

    expect(sessionBlock.peekProperty(activePanelIdProp)).toBe('panel-b')
  })

  it('keeps the panel body mounted when the wide-scroll frame toggles', async () => {
    // Opening a second pane (or collapsing back to one) flips
    // wideScrollSurface. When the content frame was a conditional wrapper,
    // that changed the element type at this position and React rebuilt the
    // whole panel body — losing scroll, editor state and playback, and
    // reading as a full reload on a large view.
    const tree = (wide: boolean) => (
      <AppRuntimeContextProvider value={env.runtime}>
        <BlockContextProvider
          initialValue={{
            layoutBoundary: true,
            panelId: env.panel.id,
            wideScrollSurface: wide,
          }}
        >
          <PanelRenderer block={env.panel}/>
        </BlockContextProvider>
      </AppRuntimeContextProvider>
    )

    const view = render(tree(true))
    const body = await screen.findByTestId('panel-top-level-block')
    expect(body.parentElement?.className).toContain('max-w-3xl')

    view.rerender(tree(false))

    const afterWidening = await screen.findByTestId('panel-top-level-block')
    expect(afterWidening).toBe(body)
    expect(body.isConnected).toBe(true)

    // …and back again, which is the collapse-to-one-pane direction.
    view.rerender(tree(true))
    expect(await screen.findByTestId('panel-top-level-block')).toBe(body)
  })

  it('does not add a content-width frame for normal panel columns', async () => {
    renderPanel(false)

    const topLevelBlock = await screen.findByTestId('panel-top-level-block')
    expect(topLevelBlock.parentElement?.className).not.toContain('max-w-3xl')
  })

  it('keeps selection-state updates out of the panel body render path', async () => {
    renderPanel(false)
    await screen.findByTestId('panel-top-level-block')

    vi.mocked(BlockComponent).mockClear()
    vi.mocked(useActionContext).mockClear()

    act(() => {
      selectionStore.set({selectedBlockIds: ['page-a'], anchorBlockId: 'page-a'})
    })

    expect(BlockComponent).not.toHaveBeenCalled()
    expect(useActionContext).toHaveBeenLastCalledWith(
      ActionContextTypes.MULTI_SELECT_MODE,
      expect.objectContaining({
        selectedBlocks: [env.repo.block('page-a')],
        anchorBlock: env.repo.block('page-a'),
      }),
      true,
    )
  })

  it('does not activate multi-select shortcuts for an inactive panel selection', async () => {
    selectionStore.set({selectedBlockIds: ['page-a'], anchorBlockId: 'page-a'})
    await renderPanelInLayoutSession('panel-b')
    await screen.findByTestId('panel-top-level-block')

    expect(vi.mocked(useActionContext).mock.calls.length).toBe(0)
  })

  it('ignores retired focused block ids for history snapshots', async () => {
    await env.repo.tx(async tx => {
      await tx.update(env.panel.id, {
        properties: {
          [topLevelBlockIdProp.name]: topLevelBlockIdProp.codec.encode('page-a'),
          focusedBlockId: 'legacy-child',
        },
      })
    }, {scope: ChangeScope.UiState, description: 'seed retired focusedBlockId'})
    renderPanel(false)
    await screen.findByTestId('panel-top-level-block')

    expect(panelHistory.snapshot(env.panel.id)?.focusedLocation).toBeUndefined()
  })

  it('renders the top-level block under a per-pane render scope', async () => {
    renderPanel(false)
    const el = await screen.findByTestId('panel-top-level-block')
    expect(el.getAttribute('data-context-render-scope-id'))
      .toBe(panelRenderScopeId('panel-a', 'page-a'))
  })

  it('threads panelViewMode into the top-level block context when the prop is set', async () => {
    await env.repo.tx(async tx => {
      await tx.setProperty(env.panel.id, panelViewModeProp, 'video-notes')
    }, {scope: ChangeScope.UiState, description: 'seed panel view mode'})
    renderPanel(false)
    const el = await screen.findByTestId('panel-top-level-block')
    expect(el.getAttribute('data-context-view-mode')).toBe('video-notes')
  })

  it('panelViewMode is absent from the context when the prop is unset', async () => {
    renderPanel(false)
    const el = await screen.findByTestId('panel-top-level-block')
    expect(el.getAttribute('data-context-view-mode')).toBe('')
  })

  it('rewrites a legacy outline-scoped stored focus location to the per-pane scope (deletable shim)', async () => {
    await env.repo.tx(async tx => {
      await tx.setProperty('panel-a', focusedBlockLocationProp, {
        blockId: 'child-x',
        renderScopeId: outlineRenderScopeId('page-a'), // pre-deploy pane scope
      })
    }, {scope: ChangeScope.UiState, description: 'seed legacy focus scope'})
    renderPanel(false)
    const el = await screen.findByTestId('panel-top-level-block')

    await vi.waitFor(() => {
      expect(peekFocusedBlockLocation(env.panel)).toEqual({
        blockId: 'child-x', // preserved
        renderScopeId: panelRenderScopeId('panel-a', 'page-a'),
      })
    })
    // useInFocus-style strict compare now matches the rendered scope.
    expect(el.getAttribute('data-context-render-scope-id'))
      .toBe(peekFocusedBlockLocation(env.panel)?.renderScopeId)
  })

  it('leaves non-legacy stored focus locations alone', async () => {
    const location = {blockId: 'child-x', renderScopeId: 'embed:parent:child-x:0'}
    await env.repo.tx(async tx => {
      await tx.setProperty('panel-a', focusedBlockLocationProp, location)
    }, {scope: ChangeScope.UiState, description: 'seed embed focus scope'})
    renderPanel(false)
    await screen.findByTestId('panel-top-level-block')

    // Settle any mount effects, then confirm the shim did not touch it.
    await act(async () => {})
    expect(peekFocusedBlockLocation(env.panel)).toEqual(location)
  })

  // A stored pixel offset means a different place after a reload: rows mount
  // lazily and their measured heights die with the page, so the document the
  // offset was taken against no longer exists. The cursor is the anchor.
  it('restores the pane by scrolling to its stored cursor row', async () => {
    const location = {blockId: 'child-x', renderScopeId: panelRenderScopeId('panel-a', 'page-a')}
    await env.repo.tx(async tx => {
      await tx.setProperty('panel-a', focusedBlockLocationProp, location)
    }, {scope: ChangeScope.UiState, description: 'seed stored cursor'})

    renderPanel(false)
    await screen.findByTestId('panel-top-level-block')

    expect(alignScrollportToRow).toHaveBeenCalledWith(expect.anything(), location, {})
  })

  // The offset rides along as the FLOOR, not the alternative: a cursor whose row
  // can never be re-resolved (an embed target, a layout root with no shell)
  // would otherwise strand the pane at the top — worse than the pixel restore.
  it('hands the stored offset down as the fallback for an unreachable cursor', async () => {
    const location = {blockId: 'child-x', renderScopeId: panelRenderScopeId('panel-a', 'page-a')}
    await env.repo.tx(async tx => {
      await tx.setProperty('panel-a', focusedBlockLocationProp, location)
      await tx.setProperty('panel-a', scrollTopProp, 480)
    }, {scope: ChangeScope.UiState, description: 'seed cursor and offset'})

    renderPanel(false)
    await screen.findByTestId('panel-top-level-block')

    expect(alignScrollportToRow)
      .toHaveBeenCalledWith(expect.anything(), location, {fallbackScrollTop: 480})
  })

  it('prefers a history restore cursor over the one still on the pane', async () => {
    const stale = {blockId: 'child-x', renderScopeId: panelRenderScopeId('panel-a', 'page-a')}
    const restored = {blockId: 'child-y', renderScopeId: panelRenderScopeId('panel-a', 'page-a')}
    await env.repo.tx(async tx => {
      await tx.setProperty('panel-a', focusedBlockLocationProp, stale)
    }, {scope: ChangeScope.UiState, description: 'seed stored cursor'})
    panelHistory.enqueueRestore('panel-a', {focusedLocation: restored})

    renderPanel(false)
    await screen.findByTestId('panel-top-level-block')

    expect(alignScrollportToRow).toHaveBeenCalledWith(expect.anything(), restored, {})
  })

  // `writePanelContent` MANUFACTURES a cursor on the destination's top-level
  // block when the snapshot has none, so peeking at the pane would read that
  // invention and anchor to the top — throwing away the offset the snapshot
  // exists to replay. Scrolling alone never creates a cursor, so this is the
  // norm for anyone who scrolls without clicking.
  it('replays the offset for a history visit that was scrolled but never focused', async () => {
    await env.repo.tx(async tx => {
      await tx.setProperty('panel-a', focusedBlockLocationProp, {
        blockId: 'page-a',
        renderScopeId: panelRenderScopeId('panel-a', 'page-a'),
      })
    }, {scope: ChangeScope.UiState, description: 'manufactured cursor'})
    panelHistory.enqueueRestore('panel-a', {scrollTop: 512})

    renderPanel(false)
    const topLevel = await screen.findByTestId('panel-top-level-block')

    expect(alignScrollportToRow).not.toHaveBeenCalled()
    expect(topLevel.closest('[data-panel-scrollport]')?.scrollTop).toBe(512)
  })

  // Under `StrictMode` — which `main.tsx` enables — the effect runs setup,
  // cleanup, setup. `consumeRestore` is destructive, so the replay used to find
  // nothing, peek the cursor `writePanelContent` manufactures for a cursorless
  // visit, and anchor to the top, undoing the offset the first pass restored.
  it('keeps a cursorless restore across the StrictMode effect replay', async () => {
    await env.repo.tx(async tx => {
      await tx.setProperty('panel-a', focusedBlockLocationProp, {
        blockId: 'page-a',
        renderScopeId: panelRenderScopeId('panel-a', 'page-a'),
      })
    }, {scope: ChangeScope.UiState, description: 'manufactured cursor'})
    panelHistory.enqueueRestore('panel-a', {scrollTop: 512})

    render(
      <StrictMode>
        <AppRuntimeContextProvider value={env.runtime}>
          <BlockContextProvider
            initialValue={{layoutBoundary: true, panelId: env.panel.id}}
          >
            <PanelRenderer block={env.panel}/>
          </BlockContextProvider>
        </AppRuntimeContextProvider>
      </StrictMode>,
    )
    const topLevel = await screen.findByTestId('panel-top-level-block')

    expect(alignScrollportToRow).not.toHaveBeenCalled()
    expect(topLevel.closest('[data-panel-scrollport]')?.scrollTop).toBe(512)
  })

  // A pane can be scrolled without ever being clicked or navigated in, so it
  // has no cursor to anchor to. The offset is still the best answer there.
  it('falls back to the stored scroll offset when the pane has no cursor', async () => {
    await env.repo.tx(async tx => {
      await tx.setProperty('panel-a', scrollTopProp, 640)
    }, {scope: ChangeScope.UiState, description: 'seed scroll offset'})

    renderPanel(false)
    const topLevel = await screen.findByTestId('panel-top-level-block')

    expect(alignScrollportToRow).not.toHaveBeenCalled()
    expect(topLevel.closest('[data-panel-scrollport]')?.scrollTop).toBe(640)
  })

  it('captures the panel view mode in history snapshots', async () => {
    await env.repo.tx(async tx => {
      await tx.setProperty(env.panel.id, topLevelBlockIdProp, 'page-a')
      await tx.setProperty(env.panel.id, panelViewModeProp, 'video-notes')
    }, {scope: ChangeScope.UiState, description: 'seed panel view mode'})
    renderPanel(false)
    await screen.findByTestId('panel-top-level-block')

    expect(panelHistory.snapshot(env.panel.id)?.viewMode).toBe('video-notes')
  })
})
