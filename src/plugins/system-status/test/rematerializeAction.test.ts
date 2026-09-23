import { beforeEach, describe, expect, it, vi } from 'vitest'
import { actionsFacet } from '@/extensions/core.js'

const mocks = vi.hoisted(() => ({
  recover: vi.fn(),
  showInfo: vi.fn(),
}))
vi.mock('@/utils/workspaceRecovery.js', () => ({
  rematerializeWorkspaceWithFeedback: (...args: unknown[]) => mocks.recover(...args),
}))
vi.mock('@/utils/toast.js', () => ({showInfo: (...args: unknown[]) => mocks.showInfo(...args)}))

import { systemStatusPlugin } from '../index.ts'
import { REMATERIALIZE_WORKSPACE_ACTION_ID, rematerializeWorkspaceAction } from '../rematerializeAction.ts'

const findAction = (extension: unknown): unknown => {
  if (Array.isArray(extension)) {
    for (const child of extension) {
      const found = findAction(child)
      if (found) return found
    }
    return undefined
  }
  if (!extension || typeof extension !== 'object') return undefined
  const contribution = extension as {facet?: {id?: string}, value?: {id?: string}}
  return contribution.facet?.id === actionsFacet.id &&
    contribution.value?.id === REMATERIALIZE_WORKSPACE_ACTION_ID
    ? extension
    : undefined
}

beforeEach(() => {
  mocks.recover.mockReset()
  mocks.showInfo.mockReset()
})

describe('system-status rematerialize action', () => {
  it('is registered with system-status for the command palette', () => {
    expect(findAction(systemStatusPlugin)).toBeTruthy()
  })

  it('captures the active workspace and invokes local recovery despite isReadOnly', async () => {
    const repo = {activeWorkspaceId: 'ws-1', isReadOnly: true}

    await rematerializeWorkspaceAction.handler(
      {uiStateBlock: {repo}} as never,
      {} as never,
    )

    expect(mocks.recover).toHaveBeenCalledTimes(1)
    expect(mocks.recover).toHaveBeenCalledWith(repo, 'ws-1')
    expect(mocks.showInfo).not.toHaveBeenCalled()
  })

  it('uses the requested command-palette label', () => {
    expect(rematerializeWorkspaceAction.description).toBe('Repair downloaded workspace data')
  })

  it('reports when there is no active workspace and does not call recovery', async () => {
    await rematerializeWorkspaceAction.handler(
      {uiStateBlock: {repo: {activeWorkspaceId: null}}} as never,
      {} as never,
    )

    expect(mocks.recover).not.toHaveBeenCalled()
    expect(mocks.showInfo).toHaveBeenCalledWith('Local workspace recovery: no active workspace.')
  })
})
