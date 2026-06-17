import { Suspense, useEffect, type ReactNode } from 'react'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { actionContextsFacet, actionsFacet } from '@/extensions/core.js'
import { resolveFacetRuntimeSync } from '@/facets/facet.js'
import { AppRuntimeContextProvider } from '@/extensions/runtimeContext.js'
import {
  ActiveContextsProvider,
  useActiveContextsDispatch,
} from '@/shortcuts/ActiveContexts.js'
import { CREATE_NODE_IN_ACTIVE_PANEL_ACTION_ID } from '@/shortcuts/defaultShortcuts.js'
import {
  type ActionContextConfig,
  ActionContextTypes,
  type ActionConfig,
  type BaseShortcutDependencies,
} from '@/shortcuts/types.js'
import { Plus } from 'lucide-react'
import { LeftSidebar, LeftSidebarShortcutsSection } from '../LeftSidebar.tsx'
import { leftSidebarToggle } from '../toggleStore.ts'

const mocks = vi.hoisted(() => {
  const repo = {id: 'repo'}
  const shortcutsBlock = {id: 'shortcuts-block'}
  const shortcutsBlockPromise = Promise.resolve(shortcutsBlock)
  const userBlock = {id: 'user-block'}

  return {
    closeSidebar: vi.fn(),
    getOrCreateShortcutsBlock: vi.fn(() => shortcutsBlockPromise),
    openBlock: vi.fn(),
    repo,
    shortcutsBlock,
    userBlock,
  }
})

vi.mock('@/context/repo.tsx', () => ({
  useRepo: () => mocks.repo,
}))

vi.mock('@/data/globalState.ts', () => ({
  useUserBlock: () => mocks.userBlock,
}))

vi.mock('@/hooks/block.ts', () => ({
  useChildren: () => [],
  useHandle: () => undefined,
}))

vi.mock('@/utils/navigation.ts', () => ({
  useBlockOpener: () => mocks.openBlock,
}))

vi.mock('../shortcuts.ts', () => ({
  getOrCreateShortcutsBlock: mocks.getOrCreateShortcutsBlock,
}))

const globalContext: ActionContextConfig<typeof ActionContextTypes.GLOBAL> = {
  type: ActionContextTypes.GLOBAL,
  displayName: 'Global',
  validateDependencies: (deps: unknown): deps is BaseShortcutDependencies =>
    typeof deps === 'object' && deps !== null && 'uiStateBlock' in deps,
}

const globalDeps = {uiStateBlock: {}} as BaseShortcutDependencies

function GlobalContextActivator() {
  const {activate, deactivate} = useActiveContextsDispatch()
  useEffect(() => {
    activate(ActionContextTypes.GLOBAL, globalDeps)
    return () => deactivate(ActionContextTypes.GLOBAL)
  }, [activate, deactivate])
  return null
}

function renderWithActions(
  actions: readonly ActionConfig[],
  children: ReactNode,
) {
  const runtime = resolveFacetRuntimeSync([
    actionContextsFacet.of(globalContext),
    ...actions.map(action => actionsFacet.of(action)),
  ])
  return render(
    <AppRuntimeContextProvider value={runtime}>
      <ActiveContextsProvider>
        <GlobalContextActivator/>
        {children}
      </ActiveContextsProvider>
    </AppRuntimeContextProvider>,
  )
}

afterEach(() => {
  cleanup()
  leftSidebarToggle.close()
  mocks.closeSidebar.mockClear()
  mocks.getOrCreateShortcutsBlock.mockClear()
  mocks.openBlock.mockClear()
})

describe('LeftSidebarShortcutsSection', () => {
  it("opens the user's Shortcuts block from the section header", async () => {
    await act(async () => {
      render(
        <Suspense fallback={<div>Loading...</div>}>
          <LeftSidebarShortcutsSection closeSidebar={mocks.closeSidebar}/>
        </Suspense>,
      )
    })

    fireEvent.click(await screen.findByRole('button', {name: 'Shortcuts'}))

    expect(mocks.getOrCreateShortcutsBlock).toHaveBeenCalledWith(mocks.userBlock)
    expect(mocks.closeSidebar).toHaveBeenCalledOnce()
    expect(mocks.openBlock).toHaveBeenCalledOnce()
    const [, ctx] = mocks.openBlock.mock.calls[0]
    expect(ctx).toEqual({blockId: mocks.shortcutsBlock.id})
  })

  it('runs the shared active-panel create action from the footer', async () => {
    const handler = vi.fn()
    const createNodeAction: ActionConfig<typeof ActionContextTypes.GLOBAL> = {
      id: CREATE_NODE_IN_ACTIVE_PANEL_ACTION_ID,
      description: 'New node',
      context: ActionContextTypes.GLOBAL,
      icon: Plus,
      handler,
    }

    renderWithActions([createNodeAction], <LeftSidebar/>)

    act(() => {
      leftSidebarToggle.open()
    })

    const button = await screen.findByRole('button', {name: 'New node'})
    await waitFor(() => {
      expect((button as HTMLButtonElement).disabled).toBe(false)
    })
    fireEvent.click(button)

    expect(handler).toHaveBeenCalledExactlyOnceWith(
      globalDeps,
      expect.objectContaining({
        type: 'left-sidebar-action',
      }),
      expect.objectContaining({
        activate: expect.any(Function),
        deactivate: expect.any(Function),
      }),
    )
  })
})
