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
    expect(outcome).toContain('3 downloaded rows reapplied locally')
    expect(outcome).toContain('Rows awaiting local verification: 7 → 3')
    expect(outcome).toContain('2 downloaded rows could not be applied')
    expect(outcome).toContain('workspace information or encryption keys were unavailable')
    expect(outcome).toContain('1 downloaded row could not be applied because decryption failed')
    expect(outcome).toContain('retrying alone will not fix this')
    expect(outcome).toContain('Some downloaded rows remain unverified locally')
    expect(outcome).not.toContain('No rows remain awaiting local verification')
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

    expect(clean).toContain('0 downloaded rows reapplied locally')
    expect(clean).toContain('Rows awaiting local verification: 0 → 0')
    expect(clean).toContain('No rows remain awaiting local verification')
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
    expect(outcome).not.toContain('No rows remain awaiting local verification')
  })

  it('identifies the original workspace after a workspace switch during recovery', async () => {
    const {repo} = fakeRepo(report(), 'ws-2')

    await rematerializeWorkspaceWithFeedback(repo, 'ws-1')

    expect(showInfo.mock.calls[1][0]).toContain('for the workspace you started in')
  })
})


describe('overlapping workspace repairs', () => {
  it('shares one repair and one outcome, then permits a fresh pass after completion', async () => {
    const expected = report()
    let complete!: (value: WorkspaceRematerialization) => void
    const pending = new Promise<WorkspaceRematerialization>(resolve => { complete = resolve })
    const {repo, rematerializeWorkspace} = fakeRepo(expected)
    rematerializeWorkspace.mockReturnValue(pending)
    const first = rematerializeWorkspaceWithFeedback(repo, 'ws-1')
    const second = rematerializeWorkspaceWithFeedback(repo, 'ws-1')
    complete(expected)
    expect(await Promise.all([first, second])).toEqual([expected, expected])
    expect(rematerializeWorkspace).toHaveBeenCalledTimes(1)
    expect(showInfo).toHaveBeenCalledTimes(2)

    const next = report({applied: 0, unappliedBefore: 3})
    rematerializeWorkspace.mockResolvedValue(next)
    expect(await rematerializeWorkspaceWithFeedback(repo, 'ws-1')).toBe(next)
    expect(rematerializeWorkspace).toHaveBeenCalledTimes(2)
  })

  it('releases a failed shared repair so a later attempt can run', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    let fail!: (error: Error) => void
    const pending = new Promise<WorkspaceRematerialization>((_resolve, reject) => { fail = reject })
    const {repo, rematerializeWorkspace} = fakeRepo(report())
    rematerializeWorkspace.mockReturnValueOnce(pending)
    const first = rematerializeWorkspaceWithFeedback(repo, 'ws-1')
    const second = rematerializeWorkspaceWithFeedback(repo, 'ws-1')
    fail(new Error('fixture failure'))
    expect(await Promise.all([first, second])).toEqual([null, null])
    expect(rematerializeWorkspace).toHaveBeenCalledTimes(1)
    expect(showInfo).toHaveBeenCalledTimes(2)

    expect(await rematerializeWorkspaceWithFeedback(repo, 'ws-1')).not.toBeNull()
    expect(rematerializeWorkspace).toHaveBeenCalledTimes(2)
  })

  it('keeps distinct workspaces and repositories independent', async () => {
    const repair = vi.fn(async (workspaceId: string) => report({workspaceId}))
    const repo = {activeWorkspaceId: 'ws-1', rematerializeWorkspace: repair} as unknown as Repo
    const other = fakeRepo(report({applied: 6}))
    const results = await Promise.all([
      rematerializeWorkspaceWithFeedback(repo, 'ws-1'),
      rematerializeWorkspaceWithFeedback(repo, 'ws-2'),
      rematerializeWorkspaceWithFeedback(other.repo, 'ws-1'),
    ])
    expect(repair).toHaveBeenCalledTimes(2)
    expect(other.rematerializeWorkspace).toHaveBeenCalledTimes(1)
    expect(results.map(value => [value?.workspaceId, value?.applied]))
      .toEqual([['ws-1', 3], ['ws-2', 3], ['ws-1', 6]])
  })
})
