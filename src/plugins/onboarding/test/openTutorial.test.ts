// @vitest-environment node
/**
 * Toast behaviour of `openTutorialInActiveWorkspace`.
 *
 * The gesture reports itself: the tutorial lands on screen. So the success
 * path says nothing, and the progress toast covers only the branch that
 * actually seeds (~1.2s of tx work) — opening an already-present tutorial
 * must not flash one.
 *
 * Everything here is stubbed down to the decision under test; the seeding
 * and idempotency this wraps are covered against a real repo in
 * ./action.test.ts and ./seed.test.ts.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  /** What the alias lookup resolves — non-null is "tutorial already there". */
  existing: null as { id: string } | null,
  activeWorkspaceId: 'ws-1' as string | null,
  /** `navigateFromGlobalCommand`'s documented shape; `null` = vetoed. */
  navigates: {ok: true} as unknown,
  seed: vi.fn(async () => 'seeded-tutorial'),
  progress: {update: vi.fn(), done: vi.fn(), fail: vi.fn()},
  showProgress: vi.fn(),
  showError: vi.fn(),
}))

vi.mock('@/utils/toast.js', () => ({
  showProgress: (message: string) => {
    mocks.showProgress(message)
    return mocks.progress
  },
  showError: (message: string) => mocks.showError(message),
}))

vi.mock('@/utils/navigation.js', () => ({
  activeWorkspaceIdPreferringHash: () => mocks.activeWorkspaceId,
  navigateFromGlobalCommand: async () => mocks.navigates,
}))

vi.mock('../seed.ts', () => ({
  seedTutorial: (...args: unknown[]) => mocks.seed(...(args as [])),
}))

import { openTutorialInActiveWorkspace } from '../action.ts'

const repo = {
  query: {aliasLookup: () => ({load: async () => mocks.existing})},
} as never

beforeEach(() => {
  mocks.existing = null
  mocks.activeWorkspaceId = 'ws-1'
  mocks.navigates = {ok: true}
  mocks.seed.mockClear().mockResolvedValue('seeded-tutorial')
  mocks.progress.done.mockClear()
  mocks.progress.fail.mockClear()
  mocks.showProgress.mockClear()
  mocks.showError.mockClear()
})

describe('openTutorialInActiveWorkspace', () => {
  it('opens an existing tutorial silently', async () => {
    mocks.existing = {id: 'tutorial-1'}

    expect(await openTutorialInActiveWorkspace(repo)).toBe(true)
    expect(mocks.seed).not.toHaveBeenCalled()
    expect(mocks.showProgress).not.toHaveBeenCalled()
    expect(mocks.showError).not.toHaveBeenCalled()
  })

  it('covers a seed with a progress toast and dismisses it without a message', async () => {
    expect(await openTutorialInActiveWorkspace(repo)).toBe(true)

    expect(mocks.showProgress).toHaveBeenCalledTimes(1)
    // No argument: a final message renders a success toast on top of the
    // tutorial the user is already looking at.
    expect(mocks.progress.done).toHaveBeenCalledWith()
  })

  it('reports a navigation that never landed, on either branch', async () => {
    // `null` is a vetoed gesture or a navigation that threw inside `navigate` —
    // either way nothing opened, and nothing on screen says so.
    mocks.navigates = null
    mocks.existing = {id: 'tutorial-1'}

    expect(await openTutorialInActiveWorkspace(repo)).toBe(false)
    expect(mocks.showError).toHaveBeenCalledWith('Insert tutorial failed: could not open the tutorial')
    expect(mocks.progress.done).not.toHaveBeenCalled()

    mocks.showError.mockClear()
    mocks.existing = null

    expect(await openTutorialInActiveWorkspace(repo)).toBe(false)
    // The seed branch has a progress toast open; it resolves as the failure
    // rather than leaving a second toast beside it.
    expect(mocks.progress.fail)
      .toHaveBeenCalledWith('Insert tutorial failed: could not open the tutorial')
    expect(mocks.showError).not.toHaveBeenCalled()
    expect(mocks.progress.done).not.toHaveBeenCalled()
  })

  it('reports a failed seed through the progress toast it opened', async () => {
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {})
    mocks.seed.mockRejectedValue(new Error('disk full'))

    expect(await openTutorialInActiveWorkspace(repo)).toBe(false)
    expect(mocks.progress.fail).toHaveBeenCalledWith('Insert tutorial failed: disk full')
    expect(mocks.showError).not.toHaveBeenCalled()
    logged.mockRestore()
  })

  it('reports a missing workspace without opening a progress toast', async () => {
    mocks.activeWorkspaceId = null

    expect(await openTutorialInActiveWorkspace(repo)).toBe(false)
    expect(mocks.showError).toHaveBeenCalledWith('Insert tutorial failed: no active workspace')
    expect(mocks.showProgress).not.toHaveBeenCalled()
  })
})
