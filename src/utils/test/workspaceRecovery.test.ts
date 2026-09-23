import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Repo, WorkspaceRematerialization } from '@/data/repo'

const showInfo = vi.fn()
vi.mock('@/utils/toast.js', () => ({showInfo: (...args: unknown[]) => showInfo(...args)}))

import {
  describeWorkspaceRematerialization,
  rematerializeWorkspaceWithFeedback,
} from '../workspaceRecovery.ts'

const report = (overrides: Partial<WorkspaceRematerialization> = {}): WorkspaceRematerialization => ({
  workspaceId: 'ws-1',
  scope: 'unapplied',
  scanned: 7,
  applied: 3,
  deferred: 2,
  skippedStale: 0,
  quarantined: 1,
  resolved: 3,
  reflagged: 0,
  unappliedBefore: 7,
  unappliedAfter: 3,
  remainingGap: {reason: 'workspace mode is unavailable', transient: false},
  ...overrides,
})

const fakeRepo = (result: WorkspaceRematerialization | Error, activeWorkspaceId = 'ws-1') => {
  const rematerializeWorkspace = vi.fn(async () => {
    if (result instanceof Error) throw result
    return result
  })
  return {
    repo: {activeWorkspaceId, rematerializeWorkspace} as unknown as Repo,
    rematerializeWorkspace,
  }
}

beforeEach(() => showInfo.mockClear())
afterEach(() => vi.restoreAllMocks())

describe('rematerializeWorkspaceWithFeedback', () => {
  it('runs one unapplied pass and reports exact counts plus deferred and quarantined causes', async () => {
    const expected = report()
    const {repo, rematerializeWorkspace} = fakeRepo(expected)

    const result = await rematerializeWorkspaceWithFeedback(repo, 'ws-1')

    expect(result).toBe(expected)
    expect(rematerializeWorkspace).toHaveBeenCalledTimes(1)
    expect(rematerializeWorkspace).toHaveBeenCalledWith('ws-1', {scope: 'unapplied'})
    expect(showInfo).toHaveBeenCalledTimes(2)
    expect(showInfo.mock.calls[0][1]).toEqual({
      id: 'workspace-rematerialization:ws-1',
      duration: Number.POSITIVE_INFINITY,
    })
    const outcome = showInfo.mock.calls[1][0] as string
    expect(outcome).toContain('3 downloaded rows restored locally')
    expect(outcome).toContain('Rows still waiting to be restored: 7 → 3')
    expect(outcome).toContain('2 downloaded rows could not be restored')
    expect(outcome).toContain('workspace information or encryption keys were unavailable')
    expect(outcome).toContain('1 downloaded row could not be restored because decryption failed')
    expect(outcome).toContain('retrying alone will not fix this')
    expect(outcome).toContain('Some downloaded data remains unrestored')
    expect(outcome).not.toContain('No downloaded data remains unrestored')
  })

  it('says recovery may be partial after a thrown pass and does not claim migration started', async () => {
    const {repo, rematerializeWorkspace} = fakeRepo(new Error('internal detail'), 'ws-2')
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})

    const result = await rematerializeWorkspaceWithFeedback(repo, 'ws-1')

    expect(result).toBeNull()
    expect(rematerializeWorkspace).toHaveBeenCalledTimes(1)
    expect(showInfo.mock.calls[1][0]).toContain('may have partially completed')
    expect(showInfo.mock.calls[1][0]).toContain('failed for the workspace you started in')
    expect(showInfo.mock.calls[1][0]).toContain('No property migration was initiated by this repair')
    expect(showInfo.mock.calls[1][0]).not.toContain('internal detail')
    expect(error).toHaveBeenCalledWith('[workspace-recovery] local repair failed', expect.any(Error))
  })

  it('uses structured report state for a clean recovery message', () => {
    const clean = describeWorkspaceRematerialization(report({
      applied: 0,
      deferred: 0,
      quarantined: 0,
      unappliedBefore: 0,
      unappliedAfter: 0,
      remainingGap: null,
    }))

    expect(clean).toContain('0 downloaded rows restored locally')
    expect(clean).toContain('Rows still waiting to be restored: 0 → 0')
    expect(clean).toContain('No downloaded data remains unrestored')
  })

  it('reports a transient remaining gap even when no unapplied rows remain', () => {
    const outcome = describeWorkspaceRematerialization(report({
      applied: 0,
      deferred: 0,
      quarantined: 0,
      unappliedBefore: 0,
      unappliedAfter: 0,
      remainingGap: {reason: 'sync work is in flight', transient: true},
    }))

    expect(outcome).toContain('Sync is still catching up or the local view is still rebuilding')
    expect(outcome).not.toContain('No downloaded data remains unrestored')
  })

  it('identifies the original workspace after a workspace switch during recovery', async () => {
    const {repo} = fakeRepo(report(), 'ws-2')

    await rematerializeWorkspaceWithFeedback(repo, 'ws-1')

    expect(showInfo.mock.calls[1][0]).toContain('for the workspace you started in')
  })
})
