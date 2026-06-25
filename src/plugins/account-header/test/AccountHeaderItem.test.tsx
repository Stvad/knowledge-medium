import { act, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AccountHeaderItem } from '../AccountHeaderItem.tsx'
import { userPageBlockId } from '@/data/stateBlocks.ts'
import { buildAppHash } from '@/utils/routing.ts'

const mocks = vi.hoisted(() => ({
  handleUserLinkClick: vi.fn(),
  signOut: vi.fn(),
  // Pin lags the hash on purpose: the link must follow the hash (the reactive
  // source of truth), not this imperative pin.
  repo: {activeWorkspaceId: 'workspace-1'},
  user: {id: 'user-1', name: 'Alice'} as {id: string; name?: string} | null,
}))

vi.mock('@/components/Login.tsx', () => ({
  useSignOut: () => mocks.signOut,
  useUser: () => mocks.user,
}))

vi.mock('@/context/repo.tsx', () => ({
  useRepo: () => mocks.repo,
}))

vi.mock('@/utils/navigation.ts', () => ({
  useOpenBlock: () => mocks.handleUserLinkClick,
}))

const switchWorkspace = (workspaceId: string) => {
  act(() => {
    window.location.hash = buildAppHash(workspaceId)
    window.dispatchEvent(new Event('hashchange'))
  })
}

describe('AccountHeaderItem', () => {
  beforeEach(() => {
    window.location.hash = buildAppHash('workspace-1')
    mocks.handleUserLinkClick.mockClear()
    mocks.user = {id: 'user-1', name: 'Alice'}
  })

  afterEach(() => {
    window.location.hash = ''
  })

  it("links the username to the active workspace's user page", () => {
    render(<AccountHeaderItem/>)

    const link = screen.getByRole('link', {name: 'Alice'})
    expect(link).toHaveAttribute(
      'href',
      buildAppHash('workspace-1', userPageBlockId('workspace-1', 'user-1')),
    )

    fireEvent.click(link)
    expect(mocks.handleUserLinkClick).toHaveBeenCalledOnce()
  })

  it('re-targets the link to the new workspace when the workspace switches', () => {
    render(<AccountHeaderItem/>)

    switchWorkspace('workspace-2')

    const link = screen.getByRole('link', {name: 'Alice'})
    expect(link).toHaveAttribute(
      'href',
      buildAppHash('workspace-2', userPageBlockId('workspace-2', 'user-1')),
    )
  })
})
