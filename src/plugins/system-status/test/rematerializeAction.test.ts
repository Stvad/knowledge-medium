import { beforeEach, describe, expect, it, vi } from 'vitest'
import { resolveAppRuntimeSync } from '@/facets/resolveAppRuntime.js'
import { actionsFacet, headerItemsFacet } from '@/extensions/core.js'

const mocks = vi.hoisted(() => ({
  recover: vi.fn(),
  showInfo: vi.fn(),
}))
vi.mock('@/utils/workspaceRecovery.js', () => ({
  rematerializeWorkspaceWithFeedback: (...args: unknown[]) => mocks.recover(...args),
}))
vi.mock('@/utils/toast.js', () => ({showInfo: (...args: unknown[]) => mocks.showInfo(...args)}))

import { systemStatusPlugin } from '../index.ts'
import { rematerializeWorkspaceAction } from '../rematerializeAction.ts'

beforeEach(() => {
  mocks.recover.mockReset()
  mocks.showInfo.mockReset()
})

describe('system-status rematerialize action', () => {
  it.each(['enabled', 'disabled', 'safe mode'])('keeps repair available with status %s', mode => {
    const runtime = resolveAppRuntimeSync([systemStatusPlugin], {
      overrides: new Map([['system:sync-status', mode !== 'disabled']]),
      safeMode: mode === 'safe mode',
    })
    expect(runtime.read(actionsFacet)).toContainEqual(rematerializeWorkspaceAction)
    expect(runtime.read(headerItemsFacet)).toHaveLength(mode === 'enabled' ? 1 : 0)
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
