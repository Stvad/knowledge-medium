// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, render, screen, waitFor } from '@testing-library/react'
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
import { swipeActiveBlockIdProp } from '../property'
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

  it('clears a persisted active block id on mount without rendering the stale menu', async () => {
    const uiStateBlock = repo.block('panel-1')
    await uiStateBlock.set(swipeActiveBlockIdProp, 'block-1')

    renderMenu()

    expect(screen.queryByRole('button', {name: 'Copy'})).toBeNull()
    await waitFor(() => {
      expect(uiStateBlock.peekProperty(swipeActiveBlockIdProp)).toBeUndefined()
    })
  })

  it('clears the active block id when panel navigation changes the top-level block', async () => {
    const uiStateBlock = repo.block('panel-1')
    renderMenu()

    await act(async () => {
      await uiStateBlock.set(swipeActiveBlockIdProp, 'block-1')
    })

    expect(await screen.findByRole('button', {name: 'Copy'})).toBeTruthy()

    await act(async () => {
      await uiStateBlock.set(topLevelBlockIdProp, 'other-root')
    })

    await waitFor(() => {
      expect(uiStateBlock.peekProperty(swipeActiveBlockIdProp)).toBeUndefined()
    })
  })
})
