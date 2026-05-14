// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { ChangeScope, type User } from '@/data/api'
import { BlockCache } from '@/data/blockCache'
import { createTestDb, type TestDb } from '@/data/test/createTestDb'
import { Repo } from '@/data/repo'
import type { Block } from '@/data/block'
import { actionsFacet } from '@/extensions/core'
import { resolveFacetRuntimeSync, type FacetRuntime } from '@/extensions/facet'
import { AppRuntimeContextProvider } from '@/extensions/runtimeContext'
import { ActionContextTypes } from '@/shortcuts/types'
import { topLevelBlockIdProp } from '@/data/properties'
import { quickActionItemsFacet } from '../actions'
import {
  SWIPE_QUICK_ACTION_CLOSE_EVENT,
  SWIPE_QUICK_ACTION_OPEN_EVENT,
  type SwipeQuickActionMenuEventDetail,
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
): CustomEvent<SwipeQuickActionMenuEventDetail> =>
  new CustomEvent(type, {
    bubbles: true,
    cancelable: true,
    detail: {blockId},
  })

describe('SwipeActionMenu', () => {
  let h: TestDb
  let repo: Repo
  let runtime: FacetRuntime

  beforeEach(async () => {
    vi.stubGlobal('ResizeObserver', TestResizeObserver)

    h = await createTestDb()
    let txSeq = 0
    repo = new Repo({
      db: h.db,
      cache: new BlockCache(),
      user: USER,
      newTxSeq: () => ++txSeq,
      startRowEventsTail: false,
    })
    repo.setActiveWorkspaceId(WS)
    runtime = resolveFacetRuntimeSync([
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
    await h.cleanup()
  })

  const renderMenu = () =>
    render(
      <AppRuntimeContextProvider value={runtime}>
        <div className="panel">
          <div data-block-id="block-1">Block</div>
          <SwipeActionMenu/>
        </div>
      </AppRuntimeContextProvider>,
    )

  const blockElement = (): HTMLElement => {
    const element = document.querySelector<HTMLElement>('[data-block-id="block-1"]')
    if (!element) throw new Error('missing block element')
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
})
