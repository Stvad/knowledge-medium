import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Workspace, WorkspaceMembership } from '@/types.js'

const mocks = vi.hoisted(() => ({
  canAccessRemoteWorkspace: vi.fn(),
  ensureLocalPersonalWorkspace: vi.fn(),
  ensurePersonalWorkspace: vi.fn(),
  getLocalWorkspace: vi.fn(),
  listLocalWorkspaces: vi.fn(),
  primeLocalWorkspaceAndMember: vi.fn(),
  recallRememberedWorkspace: vi.fn(),
  setModePin: vi.fn(),
  confirmPlaintextForSession: vi.fn(),
}))

vi.mock('@/data/workspaces.js', () => ({
  canAccessRemoteWorkspace: mocks.canAccessRemoteWorkspace,
  ensureLocalPersonalWorkspace: mocks.ensureLocalPersonalWorkspace,
  ensurePersonalWorkspace: mocks.ensurePersonalWorkspace,
  getLocalWorkspace: mocks.getLocalWorkspace,
  listLocalWorkspaces: mocks.listLocalWorkspaces,
  primeLocalWorkspaceAndMember: mocks.primeLocalWorkspaceAndMember,
}))

vi.mock('@/utils/lastWorkspace.js', () => ({
  recallRememberedWorkspace: mocks.recallRememberedWorkspace,
}))

vi.mock('@/sync/keys/modePin.js', () => ({
  setModePin: mocks.setModePin,
  confirmPlaintextForSession: mocks.confirmPlaintextForSession,
}))

const { resolveWorkspace } = await import('./resolveWorkspace.js')

const workspace = (id: string): Workspace => ({
  id,
  name: 'Personal',
  ownerUserId: 'user-1',
  createTime: 1,
  updateTime: 1,
  encryptionMode: 'none',
  wkCanary: null,
})

const member = (workspaceId: string): WorkspaceMembership => ({
  id: 'member-1',
  workspaceId,
  userId: 'user-1',
  role: 'owner',
  createTime: 1,
})

beforeEach(() => {
  vi.clearAllMocks()
  mocks.getLocalWorkspace.mockResolvedValue(null)
  mocks.recallRememberedWorkspace.mockReturnValue(null)
  mocks.primeLocalWorkspaceAndMember.mockResolvedValue(undefined)
})

describe('resolveWorkspace', () => {
  it('session-confirms a newly inserted plaintext workspace when the durable pin write fails', async () => {
    const created = workspace('ws-new')
    mocks.ensurePersonalWorkspace.mockResolvedValue({
      workspace: created,
      member: member(created.id),
      inserted: true,
    })
    mocks.setModePin.mockImplementation(() => {
      throw new Error('localStorage unavailable')
    })

    await expect(resolveWorkspace({user: {id: 'user-1'}} as never, undefined, true)).resolves.toEqual({
      id: created.id,
      freshlyCreated: true,
    })

    expect(mocks.setModePin).toHaveBeenCalledWith('user-1', created.id, 'plaintext')
    expect(mocks.confirmPlaintextForSession).toHaveBeenCalledWith('user-1', created.id)
  })
})
