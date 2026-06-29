// @vitest-environment jsdom

import { cleanup, render } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// Drive the mount's user + reactive membership surface without the data layer, and stub
// the byte store so the test pins the CLAW-BACK decision, not the OPFS delete.
const h = vi.hoisted(() => ({
  userId: 'u1',
  roles: new Map<string, string>(),
  isLoading: false,
  purgeWorkspace: vi.fn(async () => {}),
}))

vi.mock('@/context/repo.js', () => ({ useRepo: () => ({ user: { id: h.userId } }) }))
vi.mock('@/hooks/useWorkspaces.js', () => ({
  useMyWorkspaceRoles: () => ({ rolesByWorkspaceId: h.roles, isLoading: h.isLoading }),
}))
vi.mock('./byteStore.js', () => ({ getByteStore: () => ({ purgeWorkspace: h.purgeWorkspace }) }))

const { MediaRevocationPurger } = await import('./MediaRevocationPurger.js')

const roles = (...ids: string[]) => new Map(ids.map((id) => [id, 'editor']))

afterEach(cleanup)
beforeEach(() => {
  h.userId = 'u1'
  h.roles = roles()
  h.isLoading = false
  h.purgeWorkspace.mockClear()
})

describe('MediaRevocationPurger', () => {
  it('purges a workspace whose membership drops (leave / revoke)', () => {
    h.roles = roles('w1', 'w2')
    const { rerender } = render(<MediaRevocationPurger />)
    expect(h.purgeWorkspace).not.toHaveBeenCalled() // first snapshot is the baseline

    h.roles = roles('w1') // w2's membership row left the local DB
    rerender(<MediaRevocationPurger />)

    expect(h.purgeWorkspace).toHaveBeenCalledTimes(1)
    expect(h.purgeWorkspace).toHaveBeenCalledWith('u1', 'w2')
  })

  it('does NOT purge on a new membership (an addition is not a revoke)', () => {
    h.roles = roles('w1')
    const { rerender } = render(<MediaRevocationPurger />)

    h.roles = roles('w1', 'w2') // joined another workspace
    rerender(<MediaRevocationPurger />)

    expect(h.purgeWorkspace).not.toHaveBeenCalled()
  })

  it('re-baselines on an account switch — never purges the other account’s workspaces', () => {
    h.userId = 'u1'
    h.roles = roles('w1', 'w2')
    const { rerender } = render(<MediaRevocationPurger />)

    h.userId = 'u2' // signed in as a different account, with its own workspaces
    h.roles = roles('w3')
    rerender(<MediaRevocationPurger />)

    expect(h.purgeWorkspace).not.toHaveBeenCalled()
  })

  it('does not act while the membership query is still loading', () => {
    h.isLoading = true
    h.roles = roles('w1', 'w2')
    const { rerender } = render(<MediaRevocationPurger />)

    h.isLoading = false
    h.roles = roles('w1') // first SETTLED snapshot already lacks w2 → baseline only, no purge
    rerender(<MediaRevocationPurger />)

    expect(h.purgeWorkspace).not.toHaveBeenCalled()
  })
})
