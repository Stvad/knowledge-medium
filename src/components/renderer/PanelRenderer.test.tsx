// @vitest-environment jsdom

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, render, screen } from '@testing-library/react'
import { ChangeScope, type User } from '@/data/api'
import { BlockCache } from '@/data/blockCache'
import type { Block } from '@/data/block'
import { createTestDb, resetTestDb, type TestDb } from '@/data/test/createTestDb'
import { Repo } from '@/data/repo'
import {
  activePanelIdProp,
  topLevelBlockIdProp,
} from '@/data/properties'
import { BlockContextProvider } from '@/context/block'
import { resolveFacetRuntimeSync, type FacetRuntime } from '@/extensions/facet'
import { AppRuntimeContextProvider } from '@/extensions/runtimeContext'
import { PanelRenderer } from './PanelRenderer'
import { BlockComponent } from '@/components/BlockComponent.js'
import { useActionContext } from '@/shortcuts/useActionContext'
import { ActionContextTypes } from '@/shortcuts/types'
import { panelHistory } from '@/utils/panelHistory'

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

vi.mock('@/components/BlockComponent.tsx', () => ({
  BlockComponent: vi.fn(({blockId}: {blockId: string}) => (
    <div data-testid="panel-top-level-block" data-block-id={blockId}/>
  )),
}))

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
  let txSeq = 0
  const repo = new Repo({
    db: h.db,
    cache: new BlockCache(),
    user: USER,
    newTxSeq: () => ++txSeq,
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
        parentId: null,
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
    env = await setup()
  })

  afterEach(async () => {
    cleanup()
    repoRef.current = undefined
    env.repo.stopSyncObserver()
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

  const renderPanelInLayoutSession = async (activePanelId: string) => {
    await env.repo.block('layout-session').set(activePanelIdProp, activePanelId)

    return render(
      <AppRuntimeContextProvider value={env.runtime}>
        <BlockContextProvider
          initialValue={{
            layoutBoundary: true,
            layoutSessionBlockId: 'layout-session',
            panelId: env.panel.id,
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
})
