// @vitest-environment jsdom

import { Suspense } from 'react'
import { act, cleanup, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ChangeScope, type User } from '@/data/api'
import { BlockCache } from '@/data/blockCache'
import { createTestDb, type TestDb } from '@/data/test/createTestDb'
import { Repo } from '@/data/repo'
import { actionContextsFacet } from '@/extensions/core'
import { resolveFacetRuntimeSync, type FacetRuntime } from '@/extensions/facet'
import { AppRuntimeContextProvider } from '@/extensions/runtimeContext'
import { BlockContextProvider } from '@/context/block'
import { defaultActionContextConfigs } from '@/shortcuts/defaultContexts'
import {
  ActiveContextsProvider,
  useActiveContextsState,
} from '@/shortcuts/ActiveContexts'
import {
  ActionContextTypes,
  type BlockShortcutDependencies,
} from '@/shortcuts/types'
import { useShortcutSurfaceActivations } from '@/extensions/useShortcutSurfaceActivations'
import { shortcutSurfaceActivationsFacet } from '@/extensions/blockInteraction'
import {
  activePanelIdProp,
  focusedBlockLocationProp,
} from '@/data/properties'
import { outlineRenderScopeId } from '@/utils/renderScope'

const testGlobals = vi.hoisted(() => ({
  repo: undefined as Repo | undefined,
  user: {id: 'user-1', name: 'Alice'} as User,
}))

vi.mock('@/context/repo.tsx', () => ({
  useRepo: () => {
    if (!testGlobals.repo) throw new Error('test repo not initialised')
    return testGlobals.repo
  },
}))

vi.mock('@/components/Login.tsx', () => ({
  useUser: () => testGlobals.user,
}))

vi.mock('@/data/globalState.ts', async () => {
  const {useBlockContext} = await vi.importActual<typeof import('@/context/block')>('@/context/block')
  const {useHandle, usePropertyValue} = await vi.importActual<typeof import('@/hooks/block')>('@/hooks/block')
  const properties = await vi.importActual<typeof import('@/data/properties')>('@/data/properties')

  const useTestUIStateBlock = () => {
    if (!testGlobals.repo) throw new Error('test repo not initialised')
    const context = useBlockContext()
    if (typeof context.panelId === 'string') return testGlobals.repo.block(context.panelId)
    return testGlobals.repo.block('layout-session')
  }

  return {
    useUIStateBlock: useTestUIStateBlock,
    useUIStateProperty: <T,>(schema: import('@/data/api').PropertySchema<T>): [T, (value: T) => void] => {
      const block = useTestUIStateBlock()
      return usePropertyValue(block, schema)
    },
    useInFocus: (blockId: string): boolean => {
      const context = useBlockContext()
      return useHandle(useTestUIStateBlock(), {
        selector: doc => {
          const location = properties.focusedBlockLocationFromProperties(doc?.properties)
          return location?.blockId === blockId &&
            (!context.renderScopeId || location.renderScopeId === context.renderScopeId)
        },
      })
    },
    useInEditMode: (blockId: string): boolean => {
      const context = useBlockContext()
      return useHandle(useTestUIStateBlock(), {
        selector: doc => {
          const location = properties.focusedBlockLocationFromProperties(doc?.properties)
          return location?.blockId === blockId &&
            (!context.renderScopeId || location.renderScopeId === context.renderScopeId) &&
            Boolean(doc?.properties[properties.isEditingProp.name])
        },
      })
    },
    useIsSelected: (): boolean => false,
  }
})

const WS = 'ws-1'

function PanelBlockSurface({
  blockId,
  layoutSessionBlockId,
  panelId,
}: {
  blockId: string
  layoutSessionBlockId: string
  panelId: string
}) {
  return (
    <BlockContextProvider
      initialValue={{panelId, layoutSessionBlockId, renderScopeId: outlineRenderScopeId(blockId)}}
    >
      <BlockSurface blockId={blockId}/>
    </BlockContextProvider>
  )
}

function BlockSurface({blockId}: {blockId: string}) {
  if (!testGlobals.repo) throw new Error('test repo not initialised')
  useShortcutSurfaceActivations(testGlobals.repo.block(blockId), 'block')
  return <div data-testid={`surface-${blockId}`}/>
}

function ActiveNormalModeProbe() {
  const activeContexts = useActiveContextsState()
  const deps = activeContexts.get(ActionContextTypes.NORMAL_MODE) as BlockShortcutDependencies | undefined
  return <div data-testid="active-normal-mode">{deps ? `${deps.block.id}:${deps.uiStateBlock.id}` : 'none'}</div>
}

describe('useShortcutSurfaceActivations', () => {
  let h: TestDb
  let repo: Repo
  let runtime: FacetRuntime

  beforeEach(async () => {
    h = await createTestDb()
    let txSeq = 0
    repo = new Repo({
      db: h.db,
      cache: new BlockCache(),
      user: testGlobals.user,
      newTxSeq: () => ++txSeq,
      startSyncObserver: false,
    })
    repo.setActiveWorkspaceId(WS)
    testGlobals.repo = repo

    runtime = resolveFacetRuntimeSync([
      ...defaultActionContextConfigs.map(context => actionContextsFacet.of(context)),
      shortcutSurfaceActivationsFacet.of(context => context.inFocus
        ? [{
          context: ActionContextTypes.NORMAL_MODE,
          dependencies: {block: context.block},
        }]
        : null,
      ),
    ])

    await repo.tx(async tx => {
      await tx.create({
        id: 'layout-session',
        workspaceId: WS,
        parentId: null,
        orderKey: 'a0',
        content: 'Layout session',
        properties: {
          [activePanelIdProp.name]: activePanelIdProp.codec.encode('panel-b'),
        },
      })
      await tx.create({
        id: 'panel-a',
        workspaceId: WS,
        parentId: 'layout-session',
        orderKey: 'a0',
        content: 'Panel A',
        properties: {
          [focusedBlockLocationProp.name]: focusedBlockLocationProp.codec.encode({
            blockId: 'block-a',
            renderScopeId: outlineRenderScopeId('block-a'),
          }),
        },
      })
      await tx.create({
        id: 'panel-b',
        workspaceId: WS,
        parentId: 'layout-session',
        orderKey: 'a1',
        content: 'Panel B',
        properties: {
          [focusedBlockLocationProp.name]: focusedBlockLocationProp.codec.encode({
            blockId: 'block-b',
            renderScopeId: outlineRenderScopeId('block-b'),
          }),
        },
      })
      await tx.create({
        id: 'block-a',
        workspaceId: WS,
        parentId: null,
        orderKey: 'b0',
        content: 'Block A',
      })
      await tx.create({
        id: 'block-b',
        workspaceId: WS,
        parentId: null,
        orderKey: 'b1',
        content: 'Block B',
      })
    }, {scope: ChangeScope.BlockDefault, description: 'create shortcut surface fixture'})
  })

  afterEach(async () => {
    cleanup()
    testGlobals.repo = undefined
    await h.cleanup()
  })

  it('moves block shortcut ownership when the active panel changes without changing focused location', async () => {
    render(
      <AppRuntimeContextProvider value={runtime}>
        <ActiveContextsProvider>
          <Suspense fallback={<div>Loading...</div>}>
            <PanelBlockSurface
              blockId="block-a"
              layoutSessionBlockId="layout-session"
              panelId="panel-a"
            />
            <PanelBlockSurface
              blockId="block-b"
              layoutSessionBlockId="layout-session"
              panelId="panel-b"
            />
            <ActiveNormalModeProbe/>
          </Suspense>
        </ActiveContextsProvider>
      </AppRuntimeContextProvider>,
    )

    await screen.findByText('block-b:panel-b')

    await act(async () => {
      await repo.block('layout-session').set(activePanelIdProp, 'panel-a')
    })

    await waitFor(() => {
      expect(screen.getByTestId('active-normal-mode')).toHaveTextContent('block-a:panel-a')
    })
  })
})
