import { Suspense } from 'react'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { LeftSidebarShortcutsSection } from '../LeftSidebar.tsx'

const mocks = vi.hoisted(() => {
  const repo = {id: 'repo'}
  const shortcutsBlock = {id: 'shortcuts-block'}
  const shortcutsBlockPromise = Promise.resolve(shortcutsBlock)
  const userBlock = {id: 'user-block'}

  return {
    closeSidebar: vi.fn(),
    createNodeInActivePanel: vi.fn(),
    getOrCreateShortcutsBlock: vi.fn(() => shortcutsBlockPromise),
    navigateFromGlobalCommand: vi.fn(),
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
  navigateFromGlobalCommand: mocks.navigateFromGlobalCommand,
}))

vi.mock('../panelTarget.tsx', () => ({
  createNodeInActivePanel: mocks.createNodeInActivePanel,
  useActivePanelNodeTarget: () => ({
    activeTopLevelBlockId: 'active-block',
    canCreateNode: true,
    parentId: 'active-block',
  }),
}))

vi.mock('../shortcuts.ts', () => ({
  getOrCreateShortcutsBlock: mocks.getOrCreateShortcutsBlock,
}))

afterEach(() => {
  cleanup()
  mocks.closeSidebar.mockClear()
  mocks.createNodeInActivePanel.mockClear()
  mocks.getOrCreateShortcutsBlock.mockClear()
  mocks.navigateFromGlobalCommand.mockClear()
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
    expect(mocks.navigateFromGlobalCommand).toHaveBeenCalledExactlyOnceWith(
      mocks.repo,
      {blockId: mocks.shortcutsBlock.id},
    )
  })
})
