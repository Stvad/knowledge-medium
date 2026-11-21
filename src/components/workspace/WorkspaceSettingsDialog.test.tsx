// @vitest-environment happy-dom
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Workspace, WorkspaceRole } from '@/types'
import { WorkspaceSettingsDialog } from './WorkspaceSettingsDialog'

const mocks = vi.hoisted(() => ({
  roles: new Map<string, WorkspaceRole>(),
}))

// A locked workspace's gate leaves the repo read-only for every role.
vi.mock('@/context/repo', () => ({
  useRepo: () => ({user: {id: 'member-1'}, isReadOnly: true}),
}))

vi.mock('@/hooks/useWorkspaces', () => ({
  useMyWorkspaceRoles: () => ({rolesByWorkspaceId: mocks.roles, isLoading: false}),
}))

vi.mock('@/data/workspaces', () => ({
  deleteWorkspace: vi.fn(),
  inviteMemberByEmail: vi.fn(),
  listWorkspaceMembersWithEmails: vi.fn(async () => []),
  removeWorkspaceMember: vi.fn(),
  renameWorkspace: vi.fn(),
  updateWorkspaceMemberRole: vi.fn(),
}))

const workspace: Workspace = {
  id: 'ws-1',
  name: 'Vault',
  ownerUserId: 'owner-1',
  createTime: 0,
  updateTime: 0,
  encryptionMode: 'e2ee',
  wkCanary: null,
  propertiesMigration: 'cell',
}

const renderDialog = () =>
  render(<WorkspaceSettingsDialog workspace={workspace} open onOpenChange={() => {}} onDeleted={() => {}}/>)

describe('WorkspaceSettingsDialog — read-only notice', () => {
  afterEach(() => {
    cleanup()
    mocks.roles.clear()
  })

  it("follows the member's role, not the repo's read-only flag", async () => {
    mocks.roles.set('ws-1', 'editor')
    renderDialog()
    expect(await screen.findByText(/only the workspace owner can/i)).toBeInTheDocument()
    expect(screen.queryByText(/read-only access/i)).toBeNull()
  })

  it('tells a viewer it has read-only access', async () => {
    mocks.roles.set('ws-1', 'viewer')
    renderDialog()
    expect(await screen.findByText(/read-only access/i)).toBeInTheDocument()
  })
})
