import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { AccountHeaderItem } from '../AccountHeaderItem.tsx'

const mocks = vi.hoisted(() => ({
  handleUserLinkClick: vi.fn(),
  signOut: vi.fn(),
  userBlock: {id: 'user-block'},
  repo: {activeWorkspaceId: 'workspace-1'},
  user: {id: 'user-1', name: 'Alice'},
}))

vi.mock('@/components/Login.tsx', () => ({
  useSignOut: () => mocks.signOut,
  useUser: () => mocks.user,
}))

vi.mock('@/context/repo.tsx', () => ({
  useRepo: () => mocks.repo,
}))

vi.mock('@/data/globalState.ts', () => ({
  useUserBlock: () => mocks.userBlock,
}))

vi.mock('@/utils/navigation.ts', () => ({
  useBlockLinkClick: () => mocks.handleUserLinkClick,
}))

describe('AccountHeaderItem', () => {
  it("links the username to the user's page", () => {
    render(<AccountHeaderItem/>)

    const link = screen.getByRole('link', {name: 'Alice'})
    expect(link).toHaveAttribute('href', '#workspace-1/user-block')
    expect(link).toHaveClass('inline-flex', 'h-7', 'items-center', 'no-underline', 'hover:no-underline')

    fireEvent.click(link)
    expect(mocks.handleUserLinkClick).toHaveBeenCalledOnce()
  })
})
