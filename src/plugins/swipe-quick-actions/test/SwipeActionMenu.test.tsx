// @vitest-environment jsdom

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { ChangeScope, type User } from '@/data/api'
import { BlockCache } from '@/data/blockCache'
import { createTestDb, resetTestDb, type TestDb } from '@/data/test/createTestDb'
import { Repo } from '@/data/repo'
import type { Block } from '@/data/block'
import { actionContextsFacet, actionTransformsFacet, actionsFacet } from '@/extensions/core'
import { resolveFacetRuntimeSync, type AppExtension, type FacetRuntime } from '@/facets/facet'
import { AppRuntimeContextProvider } from '@/extensions/runtimeContext'
import { ActiveContextsProvider } from '@/shortcuts/ActiveContexts'
import { HotkeyReconciler } from '@/shortcuts/HotkeyReconciler'
import { defaultActionContextConfigs } from '@/shortcuts/defaultContexts'
import { type ActionConfig, ActionContextTypes, type BlockShortcutDependencies } from '@/shortcuts/types'
import { topLevelBlockIdProp } from '@/data/properties'
import { quickActionItemsFacet, SWIPE_RIGHT_BLOCK_ACTION_ID } from '../actions'
import {
  SWIPE_QUICK_ACTION_CLOSE_EVENT,
  SWIPE_QUICK_ACTION_OPEN_EVENT,
  SWIPE_QUICK_ACTION_RUN_EVENT,
  type SwipeQuickActionMenuEventDetail,
  type SwipeQuickActionRunEventDetail,
} from '../events'
import { SwipeActionMenu } from '../SwipeActionMenu'

const uiStateBlockRef = vi.hoisted(() => ({
  current: undefined as Block | undefined,
}))

vi.mock('@/data/globalState', async () => {
  const actual = await vi.importActual<typeof import('@/data/globalState')>('@/data/globalState')
  return {
    ...actual,
    useUIStateBlock: () => {
      if (!uiStateBlockRef.current) throw new Error('test UI state block not initialised')
      return uiStateBlockRef.current
    },
  }
})

vi.mock('@/utils/react.tsx', () => ({
  useIsMobile: () => true,
}))

const WS = 'ws-1'
const USER: User = {id: 'user-1', name: 'Alice'}

class TestResizeObserver {
  observe(): void {}
  disconnect(): void {}
}

const menuEvent = (
  type: typeof SWIPE_QUICK_ACTION_OPEN_EVENT | typeof SWIPE_QUICK_ACTION_CLOSE_EVENT,
  blockId = 'block-1',
  renderScopeId?: string,
): CustomEvent<SwipeQuickActionMenuEventDetail> =>
  new CustomEvent(type, {
    bubbles: true,
    cancelable: true,
    detail: renderScopeId ? {blockId, renderScopeId} : {blockId},
  })

const runEvent = (
  actionId = SWIPE_RIGHT_BLOCK_ACTION_ID,
  blockId = 'block-1',
  renderScopeId?: string,
): CustomEvent<SwipeQuickActionRunEventDetail> =>
  new CustomEvent(SWIPE_QUICK_ACTION_RUN_EVENT, {
    bubbles: true,
    cancelable: true,
    detail: renderScopeId ? {blockId, renderScopeId, actionId} : {blockId, actionId},
  })

// The swipe menu dispatches actions through the unified by-id path, which is a
// no-op until <HotkeyReconciler/> installs its dispatcher — so every runtime
// here registers the default action contexts (for deps validation) and the
// render mounts the coordinator inside an ActiveContextsProvider.
const buildRuntime = (contributions: AppExtension): FacetRuntime =>
  resolveFacetRuntimeSync([
    ...defaultActionContextConfigs.map(c => actionContextsFacet.of(c)),
    contributions,
  ])

describe('SwipeActionMenu', () => {
  let sharedDb: TestDb
  let h: TestDb
  let repo: Repo
  let runtime: FacetRuntime

  beforeAll(async () => { sharedDb = await createTestDb() })
  afterAll(async () => { await sharedDb.cleanup() })
  beforeEach(async () => {
    vi.stubGlobal('ResizeObserver', TestResizeObserver)

    await resetTestDb(sharedDb.db)
    h = sharedDb
    let txSeq = 0
    repo = new Repo({
      db: h.db,
      cache: new BlockCache(),
      user: USER,
      newTxSeq: () => ++txSeq,
      startSyncObserver: false,
    })
    repo.setActiveWorkspaceId(WS)
    runtime = buildRuntime([
      actionsFacet.of({
        id: 'copy_block',
        description: 'Copy block',
        context: ActionContextTypes.NORMAL_MODE,
        handler: vi.fn(),
      }, {source: 'test'}),
      quickActionItemsFacet.of({actionId: 'copy_block', label: 'Copy'}, {source: 'test'}),
    ])

    await repo.tx(async tx => {
      await tx.create({
        id: 'root',
        workspaceId: WS,
        parentId: null,
        orderKey: 'a0',
        content: 'Root',
      })
      await tx.create({
        id: 'block-1',
        workspaceId: WS,
        parentId: 'root',
        orderKey: 'a0',
        content: 'Block',
      })
      await tx.create({
        id: 'panel-1',
        workspaceId: WS,
        parentId: null,
        orderKey: 'a1',
        content: 'panel',
        properties: {
          [topLevelBlockIdProp.name]: topLevelBlockIdProp.codec.encode('root'),
        },
      })
    }, {scope: ChangeScope.BlockDefault, description: 'create swipe menu fixture'})

    uiStateBlockRef.current = repo.block('panel-1')
  })

  afterEach(async () => {
    cleanup()
    vi.unstubAllGlobals()
    uiStateBlockRef.current = undefined
    repo.stopSyncObserver()
  })

  const renderMenu = () =>
    render(
      <AppRuntimeContextProvider value={runtime}>
        <ActiveContextsProvider>
          <HotkeyReconciler/>
          <div className="panel">
            <div data-block-id="block-1">Block</div>
            <SwipeActionMenu/>
          </div>
        </ActiveContextsProvider>
      </AppRuntimeContextProvider>,
    )

  const blockElement = (): HTMLElement => {
    const element = document.querySelector<HTMLElement>('[data-block-id="block-1"]')
    if (!element) throw new Error('missing block element')
    return element
  }

  const scopedBlockElement = (renderScopeId: string): HTMLElement => {
    const element = document.querySelector<HTMLElement>(
      `[data-block-id="block-1"][data-render-scope-id="${renderScopeId}"]`,
    )
    if (!element) throw new Error(`missing scoped block element ${renderScopeId}`)
    return element
  }

  it('opens from a panel-local swipe event without persisted state', async () => {
    renderMenu()
    expect(screen.queryByRole('button', {name: 'Copy'})).toBeNull()

    let event: CustomEvent<SwipeQuickActionMenuEventDetail> | undefined
    act(() => {
      event = menuEvent(SWIPE_QUICK_ACTION_OPEN_EVENT)
      blockElement().dispatchEvent(event)
    })

    expect(event?.defaultPrevented).toBe(true)
    expect(await screen.findByRole('button', {name: 'Copy'})).toBeTruthy()
  })

  it('renders iconless action labels visibly and omits the dedicated close button', async () => {
    renderMenu()

    act(() => {
      blockElement().dispatchEvent(menuEvent(SWIPE_QUICK_ACTION_OPEN_EVENT))
    })

    expect(await screen.findByRole('button', {name: 'Copy'})).toHaveTextContent('Copy')
    expect(screen.queryByRole('button', {name: 'Close'})).toBeNull()
  })

  it('closes from a same-block panel-local swipe event', async () => {
    renderMenu()

    act(() => {
      blockElement().dispatchEvent(menuEvent(SWIPE_QUICK_ACTION_OPEN_EVENT))
    })
    expect(await screen.findByRole('button', {name: 'Copy'})).toBeTruthy()

    let close: CustomEvent<SwipeQuickActionMenuEventDetail> | undefined
    act(() => {
      close = menuEvent(SWIPE_QUICK_ACTION_CLOSE_EVENT)
      blockElement().dispatchEvent(close)
    })

    expect(close?.defaultPrevented).toBe(true)
    await waitFor(() => {
      expect(screen.queryByRole('button', {name: 'Copy'})).toBeNull()
    })
  })

  it('closes from a rightward swipe on the open toolbar', async () => {
    renderMenu()

    act(() => {
      blockElement().dispatchEvent(menuEvent(SWIPE_QUICK_ACTION_OPEN_EVENT))
    })
    expect(await screen.findByRole('button', {name: 'Copy'})).toBeTruthy()

    const menu = document.querySelector<HTMLElement>('.swipe-action-menu')
    if (!menu) throw new Error('missing swipe action menu')

    fireEvent.touchStart(menu, {
      changedTouches: [{identifier: 1, clientX: 40, clientY: 100}],
    })
    fireEvent.touchEnd(menu, {
      changedTouches: [{identifier: 1, clientX: 110, clientY: 102}],
    })

    await waitFor(() => {
      expect(screen.queryByRole('button', {name: 'Copy'})).toBeNull()
    })
  })

  it('clears the active block id when panel navigation changes the top-level block', async () => {
    const uiStateBlock = repo.block('panel-1')
    renderMenu()

    act(() => {
      blockElement().dispatchEvent(menuEvent(SWIPE_QUICK_ACTION_OPEN_EVENT))
    })

    expect(await screen.findByRole('button', {name: 'Copy'})).toBeTruthy()

    await act(async () => {
      await uiStateBlock.set(topLevelBlockIdProp, 'other-root')
    })

    await waitFor(() => {
      expect(screen.queryByRole('button', {name: 'Copy'})).toBeNull()
    })
  })

  it('hides items whose action.isVisible returns false for the swiped block', async () => {
    const alwaysAction: ActionConfig<typeof ActionContextTypes.NORMAL_MODE> = {
      id: 'always',
      description: 'Always',
      context: ActionContextTypes.NORMAL_MODE,
      handler: vi.fn(),
    }
    const gatedAction: ActionConfig<typeof ActionContextTypes.NORMAL_MODE> = {
      id: 'gated',
      description: 'Gated',
      context: ActionContextTypes.NORMAL_MODE,
      isVisible: ({block}) => block.id !== 'block-1',
      handler: vi.fn(),
    }
    runtime = buildRuntime([
      actionsFacet.of(alwaysAction, {source: 'test'}),
      actionsFacet.of(gatedAction, {source: 'test'}),
      quickActionItemsFacet.of({actionId: 'always', label: 'Always'}, {source: 'test'}),
      quickActionItemsFacet.of({actionId: 'gated', label: 'Gated'}, {source: 'test'}),
    ])
    renderMenu()

    act(() => {
      blockElement().dispatchEvent(menuEvent(SWIPE_QUICK_ACTION_OPEN_EVENT))
    })

    expect(await screen.findByRole('button', {name: 'Always'})).toBeTruthy()
    expect(screen.queryByRole('button', {name: 'Gated'})).toBeNull()
  })

  it('passes the render scope from swipe menu events into action deps', async () => {
    const handler = vi.fn((deps: BlockShortcutDependencies) => {
      expect(deps.block.id).toBe('block-1')
    })
    const isVisible = vi.fn((deps: BlockShortcutDependencies) => deps.block.id === 'block-1')
    runtime = buildRuntime([
      actionsFacet.of({
        id: 'scoped_action',
        description: 'Scoped action',
        context: ActionContextTypes.NORMAL_MODE,
        isVisible,
        handler,
      }, {source: 'test'}),
      quickActionItemsFacet.of({actionId: 'scoped_action', label: 'Scoped'}, {source: 'test'}),
    ])
    render(
      <AppRuntimeContextProvider value={runtime}>
        <ActiveContextsProvider>
          <HotkeyReconciler/>
          <div className="panel">
            <div data-block-id="block-1" data-render-scope-id="scope-a">Outline</div>
            <div data-block-id="block-1" data-render-scope-id="scope-b">Embed</div>
            <SwipeActionMenu/>
          </div>
        </ActiveContextsProvider>
      </AppRuntimeContextProvider>,
    )

    act(() => {
      scopedBlockElement('scope-b').dispatchEvent(
        menuEvent(SWIPE_QUICK_ACTION_OPEN_EVENT, 'block-1', 'scope-b'),
      )
    })
    fireEvent.click(await screen.findByRole('button', {name: 'Scoped'}))

    expect(isVisible.mock.calls.some(([deps]) => deps.renderScopeId === 'scope-b')).toBe(true)
    const deps = handler.mock.calls[0]?.[0] as BlockShortcutDependencies | undefined
    expect(deps?.block.id).toBe('block-1')
    expect(deps?.uiStateBlock.id).toBe('panel-1')
    expect(deps?.renderScopeId).toBe('scope-b')
  })

  it('runs swipe-right action events through effective action decorators', async () => {
    const calls: string[] = []
    const baseAction: ActionConfig<typeof ActionContextTypes.NORMAL_MODE> = {
      id: SWIPE_RIGHT_BLOCK_ACTION_ID,
      description: 'Swipe right',
      context: ActionContextTypes.NORMAL_MODE,
      handler: async ({block, renderScopeId}) => {
        calls.push(`base:${block.id}:${renderScopeId ?? ''}`)
      },
    }
    runtime = buildRuntime([
      actionsFacet.of(baseAction, {source: 'test'}),
      actionTransformsFacet.of({
        actionId: SWIPE_RIGHT_BLOCK_ACTION_ID,
        context: ActionContextTypes.NORMAL_MODE,
        apply: current => ({
          ...current,
          handler: async (deps, trigger) => {
            const blockDeps = deps as BlockShortcutDependencies
            calls.push(`decorated:${blockDeps.block.id}:${blockDeps.renderScopeId ?? ''}`)
            await current.handler(blockDeps, trigger)
          },
        }),
      }, {source: 'test'}),
    ])
    renderMenu()

    let event: CustomEvent<SwipeQuickActionRunEventDetail> | undefined
    await act(async () => {
      event = runEvent(SWIPE_RIGHT_BLOCK_ACTION_ID, 'block-1', 'scope-b')
      blockElement().dispatchEvent(event)
    })

    expect(event?.defaultPrevented).toBe(true)
    expect(calls).toEqual(['decorated:block-1:scope-b', 'base:block-1:scope-b'])
  })
})
