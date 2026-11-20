// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Workspace } from '@/types'
import { recallRememberedWorkspace, rememberWorkspace } from '@/utils/lastWorkspace'
import { WorkspaceSwitcher } from './WorkspaceSwitcher'

const workspace = (id: string, name: string): Workspace => ({
  id,
  name,
  ownerUserId: 'owner-1',
  createTime: 0,
  updateTime: 0,
  encryptionMode: 'e2ee',
  wkCanary: null,
  propertiesMigration: 'cell',
})

vi.mock('@/hooks/useWorkspaces', () => ({
  useWorkspaces: () => ({workspaces: [workspace('ws-gated', 'Vault'), workspace('ws-other', 'Notes')], isLoading: false}),
  useMyWorkspaceRoles: () => ({rolesByWorkspaceId: new Map(), isLoading: false}),
  // The pin can name another workspace than the gate shows (a superseded resolution).
  useActiveWorkspaceId: () => 'ws-other',
}))

vi.mock('@/context/repo', () => ({
  useRepo: () => ({setActiveWorkspaceId: vi.fn()}),
}))

vi.mock('@/components/Login', () => ({useIsLocalOnly: () => false}))

vi.mock('@/components/workspace/CreateWorkspaceDialog', () => ({CreateWorkspaceDialog: () => null}))

vi.mock('@/components/workspace/WorkspaceSettingsDialog', () => ({
  WorkspaceSettingsDialog: ({workspace, open, onDeleted}: {workspace: Workspace; open: boolean; onDeleted: () => void}) =>
    open ? (
      <div role="dialog" aria-label={`Settings for ${workspace.name}`}>
        <button type="button" onClick={onDeleted}>Simulate delete</button>
      </div>
    ) : null,
}))

describe('WorkspaceSwitcher — on a key gate', () => {
  beforeEach(() => {
    window.localStorage.clear()
    window.location.hash = ''
  })
  afterEach(() => cleanup())

  const renderGated = () => {
    const onLeave = vi.fn()
    render(<WorkspaceSwitcher gate={{workspaceId: 'ws-gated', onLeave}}/>)
    fireEvent.click(screen.getByRole('button', {name: 'Workspace settings'}))
    return onLeave
  }

  it("opens the gated workspace's settings, not the active one's", () => {
    renderGated()
    expect(screen.getByRole('dialog', {name: 'Settings for Vault'})).toBeInTheDocument()
  })

  it('leaves through the host once the workspace is deleted, though the hash is already empty', () => {
    const onLeave = renderGated()
    fireEvent.click(screen.getByRole('button', {name: 'Simulate delete'}))
    expect(onLeave).toHaveBeenCalledTimes(1)
  })

  it('forgets the remembered workspace only when it is the one deleted', () => {
    rememberWorkspace('ws-other')
    renderGated()
    fireEvent.click(screen.getByRole('button', {name: 'Simulate delete'}))
    expect(recallRememberedWorkspace()).toBe('ws-other')
    cleanup()

    rememberWorkspace('ws-gated')
    renderGated()
    fireEvent.click(screen.getByRole('button', {name: 'Simulate delete'}))
    expect(recallRememberedWorkspace()).toBeUndefined()
  })
})
